import type { CID } from "multiformats";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";
import { isCASObjectTrashed } from "#src/utils/casCopies";
import allowedDirsForRestore from "#src/utils/allowedDirsForRestore";
import { Notice } from "obsidian";
import defineLocales from "../utils/defineLocales";
import CoalescedNotice from "#src/utils/CoalescedNotice";

/** 恢复提示的合并窗口（毫秒） */
const RESTORE_NOTICE_WINDOW_MS = 500;

// 定义提示消息的国际化
const { t } = defineLocales({
	en: {
		autoRestoredMsg: (count: number) =>
			`Successfully restored ${count} referenced file(s) from the recycle bin.`,
	},
	zh: {
		autoRestoredMsg: (count: number) =>
			`已自动从回收站恢复了 ${count} 个被引用的文件。`,
	},
});

/**
 * 恢复提示的合并通知器：模块级共享实例，使并发到达的多次恢复调用合并为一条提示
 * （引用索引阶段会因后台扫描而高频触发恢复，见 CODING_STANDARDS「防抖聚合通知」）。
 */
const restoreNotice = new CoalescedNotice(
	(count) => new Notice(t("autoRestoredMsg")(count)),
	RESTORE_NOTICE_WINDOW_MS,
);

export interface RestoreReferencedFilesOptions {
	/** 引用类型判定：存在 ipfs:// 引用的 cid 恢复到主存储目录 */
	referenceManager: ReferenceManager;
	/** 主存储目录（存在 ipfs:// 引用的 cid 的允许恢复目录） */
	primaryDir: string;
	/** 下载目录列表（仅锁定引用的 cid 的允许恢复目录，可为空） */
	downloadDirs: string[];
	/** 可选，指定要检查的 CID 列表。如果不指定，则对所有标记为已删除的文件进行全量扫描。 */
	cids?: CID[];
	/** 可选，触发笔记中以 ipfs:// 形式引用的 cid（短路判定，跳过全库查询） */
	knownIPFSCids?: Set<string>;
}

/**
 * 从回收站恢复仍在被引用的文件。
 * 恢复目标目录由引用类型决定：存在 ipfs:// 引用 → 主存储目录；
 * 仅 internal.ipfs-locked: 锁定引用 → 下载目录列表；
 * 下载目录为空 → 原位恢复（由恢复实现回退）。
 *
 * @param cas 内容寻址存储实例
 * @param casMetadata 元数据管理实例
 * @param options 引用类型判定依赖与恢复目录来源
 */
export default async function restoreReferencedFiles(
	cas: CAS,
	casMetadata: CASMetadata,
	options: RestoreReferencedFilesOptions,
): Promise<number> {
	const { referenceManager, primaryDir, downloadDirs, cids, knownIPFSCids } =
		options;
	/** 单个 cid 的允许恢复目录列表；触发笔记已知为 ipfs:// 引用时短路判定 */
	const allowedDirsFor = async (cid: CID): Promise<string[] | undefined> => {
		const hasIPFS = knownIPFSCids?.has(cid.toString())
			? true
			: await referenceManager.hasIPFSReference(cid);
		return allowedDirsForRestore(hasIPFS, primaryDir, downloadDirs);
	};

	let count = 0;

	if (cids && cids.length > 0) {
		// 局部恢复：在解析出新链接的索引阶段，检查这一批 CID
		// TODO: 逐条串行（无并发爆炸风险，但批量恢复可更快），需要时可改为有界并发的有序原语
		for (const cid of cids) {
			const meta = await casMetadata.get(cid);
			// 只有该文件之前在元数据中标记为被删时才执行物理恢复
			if (meta && isCASObjectTrashed(meta)) {
				const didRestore = await cas.restoreIfTrashed(
					cid,
					await allowedDirsFor(cid),
				);
				if (didRestore) {
					count++;
				}
			}
		}
	} else {
		// 全量恢复：在用户手动命令触发，或者清空垃圾箱之前触发
		// TODO: 逐条串行（无并发爆炸风险，但批量恢复可更快），需要时可改为有界并发的有序原语
		for await (const { node } of casMetadata.find({
			filterBy: {
				isTrashed: true,
				hasReference: true,
			},
			signal: undefined,
		})) {
			const didRestore = await cas.restoreIfTrashed(
				node.cid,
				await allowedDirsFor(node.cid),
			);
			if (didRestore) {
				count++;
			}
		}
	}

	// 合并提示
	if (count > 0) {
		restoreNotice.report(count);
	}

	return count;
}

import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";
import orderedParallelMap from "#src/utils/orderedParallelMap";

export interface RebuildIndexResult {
	scanned: number;
	pruned: number;
}

export interface RebuildIndexOptions {
	/** 中止信号：必填，插件卸载等场景必须能中止进行中的写入，避免多版本竞争写入 */
	signal: AbortSignal;
}

/**
 * 扫描阶段的并发上限：取存储层合并批的事务大小（CASMetadataImpl 的
 * COALESCING_BATCH_MAX_SIZE，当前 1000），使每批并发的 merge 恰好落入同一个
 * 读写事务，同时限制在飞任务数（不随附件数增长）。进度回调也按该批宽推进（每批一次）。
 * 二者只需为同一量级即可保持「一批一事务」；命令层不为此依赖存储层实现，故就地声明。
 */
export const MERGE_LIMIT = 1000;

/**
 * 重建索引并执行磁盘对账（流式，不把全部对象加载进内存）。
 *
 * 分两阶段，基于时间戳标记实现：
 * 1. 扫描磁盘存在的副本，以有界并发（≤ MERGE_LIMIT）调用 merge，把该 CID 记为
 *    lastVisitedAt = scannedAt，并以其在磁盘上的副本实例集合为准覆盖
 *    copies（含清理回收站标记）。每批并发的 merge 在存储层内部自动合并为
 *    单个读写事务（见 CASMetadataImpl 内部缓冲），无需调用方分块感知。
 * 2. 流式遍历元数据，凡 lastVisitedAt 早于 scannedAt（即本次扫描未覆盖、
 *    磁盘上已无该 CID 的任何副本）的记录执行清理：
 *    - 仍被引用：保留记录与 filename/format，仅清空副本状态并打上 lastVisitedAt，
 *      避免残留过期回收站标记（“回收站一直显示”）。
 *    - 无引用：整体删除记录。
 */
export default async function rebuildIndex(
	cas: CAS,
	casMetadata: CASMetadata,
	referenceManager: ReferenceManager,
	onProgress: ((index: number, cidStr: string) => void) | undefined,
	options: RebuildIndexOptions,
): Promise<RebuildIndexResult> {
	// signal 必填：调用方信号在 merge 收集阶段生效（入队前 throwIfAborted）
	const { signal } = options;
	const scannedAt = new Date();

	// 阶段 1：扫描磁盘，刷新仍存在副本的元数据（有界并发，每批一次进度回调）
	let scanned = 0;
	let lastCidStr = "";
	for await (const cidStr of orderedParallelMap(
		cas.objects(),
		async function* (obj): AsyncGenerator<string> {
			await casMetadata.merge(
				{ ...obj, lastVisitedAt: scannedAt },
				signal,
			);
			yield obj.cid.toString();
		},
		{ limit: MERGE_LIMIT, signal },
	)) {
		scanned += 1;
		lastCidStr = cidStr;
		// 进度按批推进：每满一批回调一次，值为已处理累计数
		if (scanned % MERGE_LIMIT === 0) {
			onProgress?.(scanned, cidStr);
		}
	}
	// 收尾：不足一批的剩余部分也要报告一次
	if (scanned % MERGE_LIMIT !== 0) {
		onProgress?.(scanned, lastCidStr);
	}

	// 阶段 2：对账清理磁盘上已无副本的残留
	let pruned = 0;
	for await (const { node } of casMetadata.find({
		filterBy: {},
		signal,
	})) {
		signal.throwIfAborted();
		if (
			node.lastVisitedAt != null &&
			node.lastVisitedAt.getTime() >= scannedAt.getTime()
		) {
			continue;
		}
		pruned++;
		const referenced =
			(await referenceManager.count(node.cid, 1, signal)) > 0;
		if (referenced) {
			// 有引用：保留记录与引用元数据，清空副本状态以退出回收站
			await casMetadata.merge(
				{ ...node, lastVisitedAt: scannedAt, copies: [] },
				signal,
			);
		} else {
			await casMetadata.delete(node.cid, signal);
		}
	}

	await referenceManager.clearCache();
	return { scanned, pruned };
}

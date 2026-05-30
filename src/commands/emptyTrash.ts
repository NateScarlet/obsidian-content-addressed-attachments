import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import restoreReferencedFiles from "./restoreReferencedFiles";

/**
 * 清空回收站
 * 在执行清空前，会自动检查并恢复所有仍在笔记中被引用的文件，防止误删。
 *
 * @param cas 内容寻址存储实例
 * @param casMetadata 元数据管理实例
 * @param onProgress 进度反馈回调
 */
export default async function emptyTrash(
	cas: CAS,
	casMetadata: CASMetadata,
	onProgress?: (index: number, cidStr: string) => void,
): Promise<void> {
	// 在开始清空之前，优先触发一次对已引用文件的恢复
	await restoreReferencedFiles(cas, casMetadata);

	let i = 0;
	// 查找当前仍被标记为已删除的所有文件，将其永久删除
	for await (const { node } of casMetadata.find({
		filterBy: {
			isTrashed: true,
		},
		signal: undefined,
	})) {
		await cas.deleteIfTrashed(node.cid);
		i++;
		if (onProgress) {
			onProgress(i, node.cid.toString());
		}
	}
}

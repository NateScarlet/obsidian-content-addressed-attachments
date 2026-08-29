import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";

export interface RebuildIndexResult {
	scanned: number;
	pruned: number;
}

/**
 * 重建索引并执行磁盘对账（流式，不把全部对象加载进内存）。
 *
 * 分两阶段，基于时间戳标记实现：
 * 1. 扫描磁盘存在的副本，merge 时把该 CID 记为 lastVisitedAt = scannedAt，
 *    并以其在磁盘上的副本实例集合为准覆盖 copies（含清理回收站标记）。
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
	onProgress?: (index: number, cidStr: string) => void,
): Promise<RebuildIndexResult> {
	const scannedAt = new Date();

	// 阶段 1：扫描磁盘，刷新仍存在副本的元数据
	let scanned = 0;
	for await (const obj of cas.objects()) {
		await casMetadata.merge({ ...obj, lastVisitedAt: scannedAt });
		scanned++;
		onProgress?.(scanned, obj.cid.toString());
	}

	// 阶段 2：对账清理磁盘上已无副本的残留
	let pruned = 0;
	for await (const { node } of casMetadata.find({
		filterBy: {},
		signal: undefined,
	})) {
		if (
			node.lastVisitedAt != null &&
			node.lastVisitedAt.getTime() >= scannedAt.getTime()
		) {
			continue;
		}
		pruned++;
		const referenced =
			(await referenceManager.count(node.cid, 1, undefined)) > 0;
		if (referenced) {
			// 有引用：保留记录与引用元数据，清空副本状态以退出回收站
			await casMetadata.merge({
				...node,
				lastVisitedAt: scannedAt,
				copies: [],
			});
		} else {
			await casMetadata.delete(node.cid);
		}
	}

	await referenceManager.clearCache();
	return { scanned, pruned };
}

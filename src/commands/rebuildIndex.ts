import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";

export interface RebuildIndexResult {
	scanned: number;
	pruned: number;
}

export interface RebuildIndexOptions {
	/** 中止信号：必填，插件卸载等场景必须能中止进行中的写入，避免多版本竞争写入 */
	signal: AbortSignal;
}

/** 内部合并批块大小：块内并行 merge 在同一个微任务链入队，自动合并为一个内部批 */
export const DEFAULT_MERGE_BATCH_SIZE = 1000;

/**
 * 重建索引并执行磁盘对账（流式，不把全部对象加载进内存）。
 *
 * 分两阶段，基于时间戳标记实现：
 * 1. 扫描磁盘存在的副本，累积成块调用 merge（块内并行）把该 CID 记为
 *    lastVisitedAt = scannedAt，并以其在磁盘上的副本实例集合为准覆盖
 *    copies（含清理回收站标记）。块内并发 merge 在存储层内部自动合并为
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

	// 阶段 1：扫描磁盘，刷新仍存在副本的元数据（按块并行合并）
	let scanned = 0;
	let pending: CASMetadataObject[] = [];
	const flush = async () => {
		if (pending.length === 0) {
			return;
		}
		// 块内并行 merge：同一微任务链入队，存储层内部自动合并为一个事务
		await Promise.all(pending.map((obj) => casMetadata.merge(obj, signal)));
		scanned += pending.length;
		onProgress?.(scanned, pending[pending.length - 1].cid.toString());
		pending = [];
	};
	for await (const obj of cas.objects()) {
		signal.throwIfAborted();
		pending.push({ ...obj, lastVisitedAt: scannedAt });
		if (pending.length >= DEFAULT_MERGE_BATCH_SIZE) {
			await flush();
		}
	}
	await flush();

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

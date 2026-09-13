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

/** 批量合并块大小：每块一个读写事务，降低事务数与中断损坏窗口 */
export const DEFAULT_MERGE_BATCH_SIZE = 1000;

/**
 * 重建索引并执行磁盘对账（流式，不把全部对象加载进内存）。
 *
 * 分两阶段，基于时间戳标记实现：
 * 1. 扫描磁盘存在的副本，累积成块调用 mergeBatch 把该 CID 记为
 *    lastVisitedAt = scannedAt，并以其在磁盘上的副本实例集合为准覆盖
 *    copies（含清理回收站标记）。
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
	// signal 必填：mergeBatch 契约要求显式中止能力，未传由类型层拒绝
	const { signal } = options;
	const scannedAt = new Date();

	// 阶段 1：扫描磁盘，刷新仍存在副本的元数据（按块批量合并）
	let scanned = 0;
	let pending: CASMetadataObject[] = [];
	const flush = async () => {
		if (pending.length === 0) {
			return;
		}
		await casMetadata.mergeBatch(pending, signal);
		scanned += pending.length;
		onProgress?.(scanned, pending[pending.length - 1].cid.toString());
		pending = [];
	};
	for await (const obj of cas.objects()) {
		signal.throwIfAborted();
		console.log("got obj", obj);
		pending.push({ ...obj, lastVisitedAt: scannedAt });
		if (pending.length >= DEFAULT_MERGE_BATCH_SIZE) {
			console.log("will flush", pending.length);
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

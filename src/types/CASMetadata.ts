import type { CID } from "multiformats";

/**
 * 一个附件副本实例：正常副本（trashedAt 为空）或回收站副本（非空）。
 * 允许同一目录同时存在正常与回收两个实例（per-instance 模型）。
 */
export interface CASMetadataCopy {
	dir: string;
	trashedAt?: Date;
}

export interface CASMetadataObject {
	cid: CID;
	indexedAt: Date;

	filename?: string;
	format?: string;
	size?: number;

	/** 最近一次磁盘对账（重建索引）时该 CID 被扫描到的时刻；用于时间戳式清理残留 */
	lastVisitedAt?: Date;

	/**
	 * 该 CID 在各目录的副本实例（含正常与回收副本）。
	 * 有任一副本 trashedAt 非空即视为处于回收站。
	 */
	copies?: CASMetadataCopy[];
}

export interface CASMetadataObjectFilters {
	cid?: CID[];
	query?: string;
	hasReference?: boolean;
	isTrashed?: boolean;
}

export interface CASMetadata {
	get(cid: CID): Promise<CASMetadataObject | undefined>;
	merge(
		obj: CASMetadataObject,
		signal?: AbortSignal,
	): Promise<{ didCreate: boolean }>;
	/**
	 * 批量合并：整块共用少量 IndexedDB 读写事务，供大规模批量写入（重建索引等）使用，
	 * 避免逐条 merge 时每条一个事务的性能与中断损坏窗口问题。
	 * 与 merge 语义一致（partial 字段保留既有值、副本以传入为准），每块提交后
	 * 派发一次聚合的批量保存事件而非逐条派发；界面更新频率由订阅方限流。
	 * signal 必填：插件卸载等场景必须能中止进行中的写入，避免多版本竞争写入。
	 */
	mergeBatch(
		objs: CASMetadataObject[],
		signal: AbortSignal,
	): Promise<{ didCreate: number; didChange: number }>;
	delete(cid: CID, signal?: AbortSignal): Promise<void>;
	/** 固定使用索引时间降序排列，不支持其他排序 */
	find(options: {
		signal: AbortSignal | undefined;
		filterBy?: CASMetadataObjectFilters;
		after?: string;
	}): AsyncIterableIterator<{
		node: CASMetadataObject;
		cursor: string;
	}>;
	estimateStorage(): Promise<{
		normalBytes: number;
		trashBytes: number;
	}>;
}

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
	/**
	 * 独立的引用状态筛选开关，不依赖 hasReference：命中时（false 表示无引用）直接信任
	 * 引用缓存做存在性判定，跳过保证缓存最新的 ensureFresh。这是「未引用」页加载加速的取舍——
	 * 缓存未刷新前结果可能短暂不准确。与 hasReference 各自独立叠加。
	 */
	unverifiedHasReference?: boolean;
	isTrashed?: boolean;
}

export interface CASMetadata {
	get(cid: CID): Promise<CASMetadataObject | undefined>;
	/**
	 * 单条合并（存储层内部自动合并）：并发到达的 merge 在同一注册窗口内
	 * 合并为单个读写事务（go 参照 runInBatch+loop 收集循环），调用方无需
	 * 感知「逐条 vs 批量」、无需自行分块。信号只在收集阶段生效（已 aborted
	 * 不入队），执行阶段由存储层后台信号控制（插件卸载时中止在飞事务）。
	 */
	merge(
		obj: CASMetadataObject,
		signal?: AbortSignal,
	): Promise<{ didCreate: boolean }>;
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

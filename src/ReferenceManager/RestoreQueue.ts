import type { CID } from "multiformats";
import isAbortError from "#src/utils/isAbortError";

/**
 * 后台恢复队列：把「解析出新链接后检查并恢复回收站副本」从扫描调用链里摘出来，
 * 改为后台持续消费。存在的理由是消除环状等待——扫描中直接 await 恢复会让
 * 恢复内部的引用查询重入同一个扫描单飞任务，永久挂起整条扫描链。
 *
 * 语义：
 * - 入队按 cid 去重；短路标志按 OR 合并（引用类型是 cid 的全局属性，
 *   任一触发笔记以 `ipfs://` 引用即成立），与全库判定口径一致。
 * - 取出后立即从待处理集合移除，处理期间到达的同一 cid 会重新入队并在后续批处理，
 *   不丢并发更新。
 * - 批级隔离错误：单批失败经 reportError 给出可见反馈后继续后续批，
 *   一个坏 cid 不中断整轮恢复。
 * - 取消：中止后不再启动新批；**在飞的那一批可能在下一个信号检查点被中断**，
 *   其余下已取出的 cid 因此未被恢复（它们已从待处理集合移除）。
 *   这只发生在插件卸载（dispose），且丢失的 cid 仍带回收站元数据，
 *   可由「恢复引用文件」命令（全量扫描 trashed+referenced）重新处理。
 */
export interface RestoreQueueOptions {
	/** 批执行器：处理一批去重后的 cid 与其短路标志集合，失败以 reject 表达 */
	restoreBatch(
		cids: CID[],
		knownIPFSCids: ReadonlySet<string>,
	): Promise<void>;
	/** 后台中止信号：中止后不再启动新批 */
	signal: AbortSignal;
	/** 批失败上报：必须是调用者可见的反馈（日志在生产构建被剥离，不算反馈） */
	reportError(error: unknown): void;
	/**
	 * 批宽（必填，无隐式默认）：调用方须传入与自身扫描并发上限一致的取值，
	 * 使「一批索引任务恰好对应一批恢复」而非各自漂移。
	 */
	batchSize: number;
}

export default class RestoreQueue {
	/**
	 * 待恢复的 cid（键为 cid 字符串，值携带 OR 合并后的短路标志）
	 */
	private readonly pending = new Map<
		string,
		{ cid: CID; hasIPFSReference: boolean }
	>();
	/** 消费循环是否在飞：并发入队只维持一个循环 */
	private drainingLoop = false;
	/** 是否已安排本注册窗口的收割（避免每次入队都同步启动消费） */
	private harvestScheduled = false;
	private readonly batchSize: number;

	constructor(private readonly options: RestoreQueueOptions) {
		this.batchSize = options.batchSize;
	}

	/**
	 * 入队一批 cid（同步返回，不面向调用者结果）：入队即触发后台消费，
	 * 调用方不等待恢复完成。
	 *
	 * 消费在微任务中启动（而非同步启动），使同一注册窗口内到达的重复 cid
	 * 在取出前完成去重——与合并批（CoalescingBatch）的收割语义一致。
	 */
	enqueue(cids: CID[], knownIPFSCids: ReadonlySet<string>): void {
		for (const cid of cids) {
			const key = cid.toString();
			const hasIPFSReference = knownIPFSCids.has(key);
			const existing = this.pending.get(key);
			if (existing) {
				// 同 cid 已被排队：短路标志 OR 合并，不重复入队
				existing.hasIPFSReference ||= hasIPFSReference;
				continue;
			}
			this.pending.set(key, { cid, hasIPFSReference });
		}
		if (this.pending.size === 0 || this.harvestScheduled) {
			return;
		}
		this.harvestScheduled = true;
		queueMicrotask(() => {
			this.harvestScheduled = false;
			// 消费循环内部已处理取消与批级失败；此处兜底避免未处理的拒绝
			this.drain().catch((error: unknown) => {
				this.options.reportError(error);
			});
		});
	}

	/** 后台消费循环：逐批取出并执行，批间检查中止 */
	private async drain(): Promise<void> {
		if (this.drainingLoop) {
			return;
		}
		this.drainingLoop = true;
		try {
			while (this.pending.size > 0) {
				if (this.options.signal.aborted) {
					return;
				}
				const batch = [...this.pending.values()].slice(
					0,
					this.batchSize,
				);
				for (const item of batch) {
					// 先移除再执行：处理期间重新入队的同一 cid 留到后续批，不丢更新
					this.pending.delete(item.cid.toString());
				}
				const cids = batch.map((item) => item.cid);
				const knownIPFSCids = new Set(
					batch
						.filter((item) => item.hasIPFSReference)
						.map((item) => item.cid.toString()),
				);
				try {
					await this.options.restoreBatch(cids, knownIPFSCids);
				} catch (error) {
					// 取消（卸载/热重载）为正常终止，不作为失败上报
					if (isAbortError(error)) {
						return;
					}
					// 批级隔离：上报后继续后续批，不因一个坏 cid 中断整轮恢复
					this.options.reportError(error);
				}
			}
		} finally {
			this.drainingLoop = false;
		}
	}
}

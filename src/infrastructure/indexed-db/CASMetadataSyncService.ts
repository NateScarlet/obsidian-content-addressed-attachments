import type { CID } from "multiformats";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";
import type { CASMetadataDirty } from "#src/types/CASMetadataSync";
import { casMetadataChanged } from "#src/events";

/**
 * 后台索引追平服务：订阅写侧失效信号，按磁盘真相重建副本状态后批量落地索引。
 *
 * 设计原则（见 CONTEXT.md「数据权威」）：磁盘为唯一可信源，索引只是可推导、
 * 可删除重建的索引。因此事件载荷不携带副本/回收站推导（可能过期），只携带
 * save 落盘直接产生的事实（文件名/格式/大小）；副本状态由本服务在落库前
 * 用磁盘探测重建。
 *
 * 消费语义为 fire-and-forget：不面向调用者结果；某个 CID 的单次写失败不阻断解析，
 * 可由后续变动或重建索引对账追平。写失败不以 console 日志充当反馈（见
 * CODING_STANDARDS.md 原则 #9），是否对用户可见（showError/Notice/UI）由组装方决定。
 */
export class CASMetadataSyncService {
	private pending = new Map<string, CASMetadataDirty>();
	private flushing = false;
	private unsub: () => void;

	constructor(
		private cas: CAS,
		private meta: CASMetadata,
		/** 插件卸载时中止进行中的批量写入，避免多版本竞争写同一 IndexedDB */
		private signal: AbortSignal,
	) {
		this.unsub = casMetadataChanged.subscribe((e) => {
			this.pending.set(e.detail.cid.toString(), e.detail);
			// 排空调度放到微任务：让同步连续到达的信号先并入 pending，
			// 首个微任务一次性快照为同一批（批量落地），其余微任务被 flushing 挡掉。
			queueMicrotask(() => void this.drain());
		});
	}

	[Symbol.dispose](): void {
		this.unsub();
		this.pending.clear();
	}

	/**
	 * 排空当前 pending 的失效信号：对每个 CID 按磁盘真相重建副本状态；
	 * 有副本则 merge，无副本则 delete。同批到达的多个 CID 折叠为一次 mergeBatch。
	 * flush 期间新到达的信号并入下一批，天然批量。
	 */
	private async drain(): Promise<void> {
		if (this.flushing || this.signal.aborted) {
			return;
		}
		this.flushing = true;
		try {
			while (this.pending.size > 0 && !this.signal.aborted) {
				const batch = [...this.pending.values()];
				this.pending.clear();
				try {
					await this.applyBatch(batch);
				} catch (error) {
					// 单批失败不阻断后续：跳过本批、继续排空，磁盘为真相可由后续变动追平。
					// 日志仅开发期可见（生产构建剥离，不是可见反馈）；面向用户的反馈由组装方决定。
					console.error(
						"Failed to sync CAS metadata, will be healed by next change or rebuild-index:",
						error,
					);
				}
			}
		} finally {
			this.flushing = false;
			// 排空期间到达的信号其 void drain() 已因 flushing 提前返回；
			// 重置标志后若仍有残留，必须再排一次，避免信号被捕获却无人处理。
			if (this.pending.size > 0 && !this.signal.aborted) {
				void this.drain();
			}
		}
	}

	/** 对一批失效信号：按磁盘真相重建副本状态，有副本则 merge，无副本则 delete */
	private async applyBatch(batch: CASMetadataDirty[]): Promise<void> {
		const merges: CASMetadataObject[] = [];
		const deletes: CID[] = [];
		for (const signal of batch) {
			const copies = await this.cas.collectCopies(signal.cid);
			if (copies.length === 0) {
				deletes.push(signal.cid);
				continue;
			}
			merges.push({
				cid: signal.cid,
				indexedAt: new Date(),
				filename: signal.filename,
				format: signal.format,
				size: signal.size,
				copies,
			});
		}

		if (merges.length > 0) {
			await this.meta.mergeBatch(merges, this.signal);
		}
		for (const cid of deletes) {
			await this.meta.delete(cid, this.signal);
		}
	}
}

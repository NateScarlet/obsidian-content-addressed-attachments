/**
 * 合并批（coalescing batch）：把注册窗口（同步块）内并发到达的请求自动合并为
 * 单个事务的通用机制（go 参考：SQLite 缓存存储 runInBatch+loop 收集循环）。
 * 写入侧（CASMetadataImpl 的 merge）与查询侧（ReferenceManager 引用计数）共用。
 *
 * 收割语义（maxWait 而非 minWait）：收到首个请求即安排一次收割（queueMicrotask，
 * 注册窗口 = 当前同步块）；收割时把队列中所有可执行请求拉入同一批交给执行器
 * （单个事务），批达到上限（maxBatchSize）时超额部分留到下一批——
 * 「在批次大小限制内立即执行所有可执行的」（go 参照：`abort = len(batch) == maxBatchSize`）。
 * 不额外等待凑批：无积压时单条请求零等待执行。
 *
 * 合并（可选 keyOf）：提供合并键时，同键请求挂靠同一执行条目、共享一次
 * 执行结果（去重 + 多 waiter 分发）；不提供时每个请求独立条目、逐项结果。
 *
 * 请求取消（go 参照 `i.done` 检查）：
 * - 收集阶段：join 时已 aborted 的信号不入队、立即 reject；
 * - 执行前已 aborted 的请求从队列移除（跳过执行）；
 * - 执行阶段不支持调用者取消——执行器使用持有者自己的后台信号（如
 *   [Symbol.dispose] 时 abort），共享事务不被个别调用方中止拖垮。
 */
export interface CoalescingBatchOptions<T> {
	/** 合并键：同键请求合并为一个执行条目、共享结果；缺省每个请求独立条目 */
	keyOf?: (item: T) => string;
}

interface Waiter<R> {
	signal: AbortSignal | undefined;
	onAbort: () => void;
	resolve: (value: R) => void;
	reject: (error: Error) => void;
}

interface Entry<T, R> {
	item: T;
	key: string | undefined;
	waiters: Waiter<R>[];
}

export default class CoalescingBatch<T, R> {
	private queue: Entry<T, R>[] = [];
	private draining = false;
	private readonly keyOf: ((item: T) => string) | undefined;

	constructor(
		/** 批执行器：一次调用处理一批（单个事务），返回与条目一一对应的逐项结果 */
		private readonly executor: (
			items: T[],
			signal: AbortSignal,
		) => Promise<R[]>,
		/** 批上限：防积压场景下批无限膨胀（max 非 min） */
		private readonly maxBatchSize: number,
		/** 执行阶段信号：由持有者后台控制（如 [Symbol.dispose] 时 abort） */
		private readonly signal: AbortSignal,
		options: CoalescingBatchOptions<T> = {},
	) {
		this.keyOf = options.keyOf;
	}

	join(item: T, signal: AbortSignal | undefined): Promise<R> {
		return new Promise<R>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			const key = this.keyOf?.(item);
			const entry =
				key !== undefined
					? this.queue.find((e) => e.key === key)
					: undefined;
			if (entry) {
				// 同键挂靠：共享同一执行条目与结果
				this.attachWaiter(entry, { signal, resolve, reject });
				return;
			}
			const created: Entry<T, R> = { item, key, waiters: [] };
			this.queue.push(created);
			this.attachWaiter(created, { signal, resolve, reject });
			if (!this.draining) {
				this.draining = true;
				queueMicrotask(() => void this.flush());
			}
		});
	}

	/** 挂靠等待者：取消时从条目与队列移除（执行前 aborted 跳过），共享条目按 waiter 独立取消 */
	private attachWaiter(
		entry: Entry<T, R>,
		waiter: {
			signal: AbortSignal | undefined;
			resolve: (value: R) => void;
			reject: (error: Error) => void;
		},
	): void {
		const onAbort = () => {
			const waiters = entry.waiters;
			const index = waiters.indexOf(attached);
			if (index >= 0) {
				waiters.splice(index, 1);
			}
			// 条目已无等待者且尚未执行：从队列移除，避免白执行
			if (waiters.length === 0) {
				const entryIndex = this.queue.indexOf(entry);
				if (entryIndex >= 0) {
					this.queue.splice(entryIndex, 1);
				}
			}
			waiter.reject(new DOMException("Aborted", "AbortError"));
		};
		const attached: Waiter<R> = {
			...waiter,
			onAbort,
		};
		waiter.signal?.addEventListener("abort", onAbort, { once: true });
		entry.waiters.push(attached);
	}

	private async flush(): Promise<void> {
		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.maxBatchSize);
				let results: R[];
				try {
					results = await this.executor(
						batch.map((entry) => entry.item),
						this.signal,
					);
				} catch (error) {
					// 批级失败传播给全部挂靠者（go 参照：事务失败后继续处理后续操作）
					const err =
						error instanceof Error
							? error
							: new Error(String(error));
					for (const entry of batch) {
						for (const waiter of entry.waiters) {
							waiter.signal?.removeEventListener(
								"abort",
								waiter.onAbort,
							);
							waiter.reject(err);
						}
					}
					continue;
				}
				for (const [index, entry] of batch.entries()) {
					for (const waiter of entry.waiters) {
						waiter.signal?.removeEventListener(
							"abort",
							waiter.onAbort,
						);
						waiter.resolve(results[index]);
					}
				}
			}
		} finally {
			this.draining = false;
		}
	}
}

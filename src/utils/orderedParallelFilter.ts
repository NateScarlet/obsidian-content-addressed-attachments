/**
 * 保序并发过滤：消费源异步可迭代对象，以受限并发执行谓词，仅按源顺序产出通过谓词的元素。
 *
 * 并发语义：按 `limit` 一批预取源元素后，同一同步批次内启动全部谓词——
 * 使并发到达的异步谓词（如引用计数）能在同一次执行中触发下游请求合并
 * （单个 IndexedDB 只读事务服务多个元素），避免顺序逐条 await 退化为逐元素事务。
 *
 * 顺序保证：产出顺序与源顺序一致，跳过不通过谓词的元素。
 * 中止：消费者提前 break 会关闭源（关闭底层游标事务）；谓词或源会随 signal 抛出中止。
 */
export interface OrderedParallelFilterOptions {
	limit?: number;
	signal?: AbortSignal;
}

/** 谓词结果（含错误，错误在按序消费到该槽时再抛，避免成为未处理拒绝） */
type Slot<T> = Promise<{ ok: boolean; item: T; error?: unknown }>;

export default async function* orderedParallelFilter<T>(
	source: AsyncIterable<T>,
	predicate: (item: T) => Promise<boolean>,
	{ limit = 8, signal }: OrderedParallelFilterOptions = {},
): AsyncGenerator<T> {
	if (!(limit >= 1)) {
		throw new RangeError("limit must be a positive integer");
	}
	const iterator = source[Symbol.asyncIterator]();
	const slots: Slot<T>[] = [];
	let sourceDone = false;

	const prefetch = async (): Promise<boolean> => {
		// 预取至多 limit 个源元素（limit >= 1 保证每次都发起取数）。
		const settled = await Promise.all(
			Array.from({ length: limit }, () => iterator.next()),
		);
		// 同步启动本批全部谓词：predicate 作为实参在循环内同步调用，保证批内并发到达。
		for (const r of settled) {
			if (r.done) {
				sourceDone = true;
				break;
			}
			const item = r.value;
			slots.push(
				Promise.resolve()
					.then(() => predicate(item))
					.then(
						(ok) => ({ ok, item }),
						(error: unknown) => ({ ok: false, item, error }),
					),
			);
		}
		return slots.length > 0;
	};

	try {
		for (;;) {
			if (slots.length === 0) {
				if (sourceDone || !(await prefetch())) {
					return;
				}
			}
			// 按源顺序消费，跳过不通过谓词的元素。
			while (slots.length > 0) {
				const { ok, item, error } = await slots.shift()!;
				if (error !== undefined) {
					// 谓词可能以任意值拒绝，规范为 Error 再抛出（避免对任意对象做隐式字符串化）
					throw error instanceof Error
						? error
						: new Error(
								typeof error === "string"
									? error
									: "谓词以非 Error 值拒绝",
							);
				}
				if (ok) {
					signal?.throwIfAborted();
					yield item;
					break;
				}
			}
		}
	} finally {
		// 消费者提前结束时关闭源，回收底层游标/事务。
		if (iterator.return) {
			await iterator.return();
		}
		signal?.throwIfAborted();
	}
}

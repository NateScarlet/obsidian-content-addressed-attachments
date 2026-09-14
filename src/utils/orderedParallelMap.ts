/**
 * 有界保序并发原语：以受限并发对源元素执行投影，并按源顺序交付投影产出的值。
 *
 * 与 `Promise.all` 的区别：`Promise.all` 会一次性启动与元素数等量的任务，
 * 上万级任务会打满内存与 IO；本原语把在飞投影数限制在 `limit` 内，
 * 既保留并发收益，又不让任务数随源规模增长。
 *
 * 启动节拍为「按批」：每批并发取至多 `limit` 个源元素，并在**同一个同步块内**
 * 调用该批全部投影。对于在同步段内发起合并批请求的投影（如引用计数查询），
 * 这保证了同批请求落在同一注册窗口而被合并为单个事务（见 CoalescingBatch）；
 * 「谁空谁起」的自由 worker 池会让相邻请求散落到不同微任务，合并失效。
 *
 * 语义：
 * - 产出严格按源顺序；投影可产出 0..n 个值（过滤 / 映射 / 一对多 / 纯副作用共用一种接口）。
 * - 每项任何时刻最多缓冲一个尚未按序交付的输出，故缓冲上限为在飞项数（≤ limit）。
 * - 投影出错时错误绑定该项，在消费者按序消费到该项时抛出（fail-fast），
 *   其后元素不再启动。
 * - 消费者提前结束（break）或中止时停止消费源、关闭在飞投影并丢弃缓冲；
 *   关闭不等于等投影跑完（不等在飞产出），避免卸载 / 热重载路径挂住。
 */
import castError from "./castError";

/** 默认并发上限：供取普通并发度的调用点显式引用；原语自身不提供默认值（依赖显式注入） */
export const DEFAULT_PARALLEL_LIMIT = 8;

/** 投影产出：异步可迭代（逐值产出）或同步可迭代（一次性产出） */
export type OrderedParallelProjection<Out> = AsyncIterable<Out> | Iterable<Out>;

/**
 * 空产出序列：纯副作用投影（只做事、不产出值）的规范返回，免去每个调用点自造空迭代器。
 * 无状态：每次取迭代器都返回新的空序列。
 */
export const EMPTY_PROJECTION: AsyncIterable<never> = {
	[Symbol.asyncIterator](): AsyncIterator<never> {
		return {
			next: () => Promise.resolve({ done: true, value: undefined }),
		};
	},
};

/**
 * 投影函数：返回该元素的产出序列（0..n 个值）。
 * 纯副作用投影返回 {@link EMPTY_PROJECTION}。
 */
export type OrderedParallelProject<T, Out> = (
	item: T,
) =>
	| OrderedParallelProjection<Out>
	| PromiseLike<OrderedParallelProjection<Out>>;

export interface OrderedParallelMapOptions {
	/** 并发上限：同时在飞的投影数不超过该值，同时也是每批的取源宽度 */
	limit: number;
	signal?: AbortSignal;
}

/** 投影当前步：值 / 产出完毕 / 出错（错误作为值携带，避免未处理拒绝） */
type Step<Out> =
	| { kind: "value"; value: Out }
	| { kind: "done" }
	| { kind: "error"; error: Error };

interface Slot<Out> {
	/** 交付当前已预拉取的一步，并立即预拉下一步（使本项持续推进且只缓冲一个输出） */
	take(): Promise<Step<Out>>;
	/** 关闭投影，释放其持有的资源。同步返回：不等在飞投影跑完（等会挂住卸载路径） */
	close(): void;
}

/**
 * 消费者放弃（break / return）的内部哨兵。
 * 用于打断阻塞中的 await：异步生成器的 `return()` 请求只有在其恢复执行后才会被处理，
 * 若正阻塞在一个 `await` 上则会一直挂住，故必须由外部主动打断。
 * 不对外抛出（消费者已放弃该项，中止不是错误）。
 */
const CANCELLED = Symbol("orderedParallelMap.cancelled");

/**
 * 关闭投影迭代器，触发其 finally 释放游标/事务等资源。
 * 不等待其完成：在飞投影可能阻塞在 await 上，等待会让卸载 / 热重载路径挂住；
 * 拒绝无处上报（消费者已放弃该项），故静默丢弃。
 */
function closeIterator<Out>(iterator: AsyncIterator<Out>): void {
	const result = iterator.return?.();
	if (result) {
		void result.catch(() => {});
	}
}

/** 投影同步抛出时构造的槽位：错误在按序消费到它时抛出 */
function failedSlot<Out>(error: Error): Slot<Out> {
	return {
		take: () => Promise.resolve<Step<Out>>({ kind: "error", error }),
		close: () => {},
	};
}

/**
 * 启动单个投影槽位。
 * 投影同步抛出时本函数同步抛出，交由调用方决定是否继续启动本批其余项。
 */
function createSlot<T, Out>(
	item: T,
	project: OrderedParallelProject<T, Out>,
): Slot<Out> {
	let iterator: AsyncIterator<Out> | undefined;
	/** 投影已结束（产出完毕或出错）：此后 take 不再预拉，close 变成无操作 */
	let finished = false;
	/** 消费者已放弃该项：就绪后立即关闭，不产出、不等待 */
	let cancelled = false;

	/** 预拉取下一步；错误规范为 Step.error，故本 Promise 永不 reject */
	const pull = async (): Promise<Step<Out>> => {
		const current = iterator;
		if (!current) {
			finished = true;
			return { kind: "done" };
		}
		try {
			const result = await current.next();
			if (result.done) {
				finished = true;
				return { kind: "done" };
			}
			return { kind: "value", value: result.value };
		} catch (error) {
			finished = true;
			return { kind: "error", error: castError(error) };
		}
	};

	// 同步段：同批投影在此于同一个同步块内被调用（合并批收益的前提）
	const created = project(item);
	let ready: Promise<Step<Out>> = Promise.resolve(created).then(
		(projection) => {
			const prepared = toAsyncIterator(projection);
			if (cancelled) {
				// 消费者在投影就绪前已放弃：不产出，关闭后即结束
				finished = true;
				closeIterator(prepared);
				return { kind: "done" };
			}
			iterator = prepared;
			return pull();
		},
		(error: unknown) => {
			finished = true;
			return { kind: "error", error: castError(error) };
		},
	);

	return {
		async take() {
			const step = await ready;
			if (step.kind === "value" && !finished) {
				// 立即预拉下一步：本项继续推进，且任何时刻最多缓冲一个未交付输出
				ready = pull();
			}
			return step;
		},
		close() {
			finished = true;
			cancelled = true;
			const current = iterator;
			iterator = undefined;
			if (current) {
				closeIterator(current);
			}
		},
	};
}

/** 按批启动投影：本批全部投影在同一个同步块内启动 */
function startBatch<T, Out>(
	items: T[],
	project: OrderedParallelProject<T, Out>,
): Slot<Out>[] {
	const batch: Slot<Out>[] = [];
	for (const item of items) {
		try {
			batch.push(createSlot(item, project));
		} catch (error) {
			// 投影同步抛出：本批其余项不再启动，错误绑定到该槽位
			batch.push(failedSlot(castError(error)));
			break;
		}
	}
	return batch;
}

/** 把同步可迭代统一为异步迭代器，使源可以是数组 / Map 等同步可迭代对象 */
function toAsyncIterator<T>(
	source: Iterable<T> | AsyncIterable<T>,
): AsyncIterator<T> {
	if (
		typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
	) {
		return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
	}
	const iterator = (source as Iterable<T>)[Symbol.iterator]();
	const returnFn = iterator.return?.bind(iterator);
	return {
		next: () => Promise.resolve(iterator.next()),
		return: returnFn
			? (value?: unknown) => Promise.resolve(returnFn(value))
			: undefined,
	};
}

/**
 * 中止作用域：让主循环的每个阻塞 await 都可被打断。
 * 消费者放弃（cancel）以哨兵打断；signal 中止以中止原因打断（对外抛 AbortError）。
 */
interface CancelScope {
	/** 与给定 Promise 竞争：消费者放弃时以哨兵拒绝，signal 中止时以中止原因拒绝 */
	race<R>(promise: Promise<R>): Promise<R>;
	/** 消费者放弃（break / return）：打断阻塞中的 await */
	cancel(): void;
	/** 解除对 signal 的监听 */
	dispose(): void;
}

function createCancelScope(signal: AbortSignal | undefined): CancelScope {
	let rejectCancel: ((reason: unknown) => void) | undefined;
	const cancelPromise = new Promise<never>((_resolve, reject) => {
		rejectCancel = reject;
	});
	// 竞态中必然被消费；此处兜底避免无人竞争时的未处理拒绝
	cancelPromise.catch(() => {});

	/** 中止监听器的注销句柄：signal 未中止时才注册 */
	let removeAbortListener: (() => void) | undefined;

	// signal 中止以中止原因拒绝，与消费者放弃（哨兵）区分开：前者对外抛错，后者静默结束
	let abortPromise: Promise<never> | undefined;
	if (signal) {
		abortPromise = new Promise<never>((_resolve, reject) => {
			const abort = () => {
				// 中止原因按契约规范为 Error（AbortSignal.reason 可为任意值）
				const reason: unknown = signal.reason;
				reject(
					reason instanceof Error
						? reason
						: new DOMException("Aborted", "AbortError"),
				);
			};
			if (signal.aborted) {
				abort();
			} else {
				signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () =>
					signal.removeEventListener("abort", abort);
			}
		});
		abortPromise.catch(() => {});
	}

	return {
		race<R>(promise: Promise<R>): Promise<R> {
			const racers: Promise<never>[] = [cancelPromise];
			if (abortPromise) {
				racers.push(abortPromise);
			}
			return Promise.race([promise, ...racers]);
		},
		cancel() {
			rejectCancel?.(CANCELLED);
		},
		dispose() {
			removeAbortListener?.();
		},
	};
}

/**
 * 以受限并发对 `source` 的每个元素执行 `project`，按源顺序产出投影结果。
 *
 * 返回手写的迭代器而非裸异步生成器：消费者 `return()`（含 `for await` 的 break）必须
 * 能打断可能正阻塞在 await 上的主循环，裸生成器会挂住（见 CANCELLED）。
 *
 * @param source 同步或异步可迭代的源
 * @param project 投影：返回该元素的产出序列（0..n 个值）
 * @param options.limit 并发上限（正整数，必填）
 * @param options.signal 中止信号：中止后在下一个交付点抛 AbortError 并关闭在飞投影
 */
export default function orderedParallelMap<T, Out>(
	source: Iterable<T> | AsyncIterable<T>,
	project: OrderedParallelProject<T, Out>,
	{ limit, signal }: OrderedParallelMapOptions,
): AsyncGenerator<Out> {
	const scope = createCancelScope(signal);

	const body = (async function* (): AsyncGenerator<Out> {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new RangeError(`limit 必须为正整数，收到 ${String(limit)}`);
		}
		const sourceIterator = toAsyncIterator(source);
		/** 当前批的在飞投影：提前结束 / 中止 / 出错时全部关闭 */
		let batch: Slot<Out>[] = [];
		try {
			// 串行快路径：limit 为 1 时无需批次与缓冲，逐项取源 → 投影 → 产出。
			// 语义与并发路径一致（同样的顺序、错误与取消行为），只是省去槽位与竞态开销。
			if (limit === 1) {
				for (;;) {
					const result = await scope.race(sourceIterator.next());
					signal?.throwIfAborted();
					if (result.done) {
						return;
					}
					// 同步抛出即向上传播：串行下同时只有该项在飞，错误出现的位置与
					// 并发路径按序抛出该槽位错误一致
					const created = await scope.race(
						Promise.resolve(project(result.value)),
					);
					const projection = toAsyncIterator(created);
					try {
						for (;;) {
							const step = await scope.race(projection.next());
							if (step.done) {
								break;
							}
							signal?.throwIfAborted();
							yield step.value;
						}
					} finally {
						// 投影产出完毕即关闭（释放游标/事务），不等其 finally 自行结束
						closeIterator(projection);
					}
				}
			}

			for (;;) {
				// 并发取一批源元素，使本批投影能在同一个同步块内启动
				const results = await scope.race(
					Promise.all(
						Array.from({ length: limit }, () =>
							sourceIterator.next(),
						),
					),
				);
				signal?.throwIfAborted();
				const items: T[] = [];
				let sourceDone = false;
				for (const result of results) {
					if (result.done) {
						sourceDone = true;
						break;
					}
					items.push(result.value);
				}
				if (items.length === 0) {
					return;
				}
				batch = startBatch(items, project);
				for (const slot of batch) {
					for (;;) {
						const step = await scope.race(slot.take());
						if (step.kind === "done") {
							break;
						}
						if (step.kind === "error") {
							throw step.error;
						}
						signal?.throwIfAborted();
						yield step.value;
					}
				}
				if (sourceDone) {
					return;
				}
			}
		} catch (error) {
			// 消费者放弃不是错误：静默结束（清理在 finally 内同步完成）
			if (error !== CANCELLED) {
				throw error;
			}
		} finally {
			const closing = batch;
			batch = [];
			// 同步清理，不等在飞投影：等待会让卸载路径挂住
			for (const slot of closing) {
				slot.close();
			}
			if (sourceIterator.return) {
				void sourceIterator.return().catch(() => {});
			}
			scope.dispose();
		}
	})();

	/** 取消请求一旦发出，后续 next 也应立即结束（不产出） */
	let cancelled = false;

	const iterator: AsyncGenerator<Out, void, unknown> = {
		next(): Promise<IteratorResult<Out, void>> {
			if (cancelled) {
				return Promise.resolve({ done: true, value: undefined });
			}
			return body.next();
		},
		return(): Promise<IteratorResult<Out, void>> {
			// 先打断主循环，再让生成器收敛（否则其 return 请求会一直排队）
			cancelled = true;
			scope.cancel();
			return body.return(undefined);
		},
		throw(error?: unknown): Promise<IteratorResult<Out, void>> {
			cancelled = true;
			scope.cancel();
			return body.throw(error);
		},
		[Symbol.asyncIterator](): AsyncGenerator<Out, void, unknown> {
			return iterator;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			await iterator.return();
		},
	};
	return iterator;
}

/** 完整消费并丢弃产出：供纯副作用调用方等待全部投影结束 */
export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
	for await (const value of iterable) {
		void value;
	}
}

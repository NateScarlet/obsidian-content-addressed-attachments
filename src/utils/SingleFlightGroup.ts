import createEventListeners from "./createEventListeners";

interface Flight<T> {
	promise: Promise<T>;
	ref: number;
	nextIndex: number;
	ctr: AbortController;
	done: boolean;
}

export default class SingleFlightGroup<T = void> {
	private m = new Map<string, Flight<T>>();

	async do(
		key: string,
		execute: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	) {
		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		using stack = new DisposableStack();
		const flight = this.obtainFlight(key, execute);
		const index = flight.nextIndex;
		flight.ref += 1;
		flight.nextIndex += 1;
		stack.defer(() => {
			flight.ref -= 1;
			if (flight.ref === 0) {
				this.m.delete(key);
				if (!flight.done) {
					// 由于 execute 返回值可能依赖 signal，需要避免在正常完成时调用 abort
					flight.ctr.abort();
				}
			}
		});

		const abortPromise = signal
			? new Promise<T>((_, reject) => {
					stack.use(
						createEventListeners(signal, ({ on }) => {
							on("abort", () => {
								reject(
									new DOMException("Aborted", "AbortError"),
								);
							});
						}),
					);
				})
			: undefined;
		const result = abortPromise
			? await Promise.race([flight.promise, abortPromise])
			: await flight.promise;

		const total = flight.nextIndex;
		function cloneIfNeeded(clone: (v: T) => T) {
			if (total > 1) {
				return clone(result);
			}
			return result;
		}
		return {
			index,
			total,
			result,
			cloneIfNeeded,
		};
	}

	private obtainFlight(
		key: string,
		execute: (signal: AbortSignal) => Promise<T>,
	): Flight<T> {
		const existed = this.m.get(key);
		if (existed) {
			return existed;
		}
		const ctr = new AbortController();
		const v = {
			promise: Promise.resolve()
				.then(() => execute(ctr.signal))
				.finally(() => {
					v.done = true;
				}),
			ctr,
			ref: 0,
			nextIndex: 0,
			done: false,
		};

		this.m.set(key, v);
		return v;
	}
}

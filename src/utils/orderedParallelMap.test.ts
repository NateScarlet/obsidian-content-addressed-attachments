/* eslint-disable @typescript-eslint/require-await -- 测试投影为最小异步生成器，无异步副作用 */
import { describe, it, expect } from "vitest";
import orderedParallelMap, {
	drain,
	type OrderedParallelProject,
} from "./orderedParallelMap";
import CoalescingBatch from "./CoalescingBatch";

/** 异步生成源：记录被消费（next 到达）的次数 */
function sourceOf(items: number[], onNext?: (n: number) => void) {
	return (async function* () {
		// 保留一个真实的 await 点，让测试能观测到批内项目已并发启动
		await Promise.resolve();
		for (const item of items) {
			onNext?.(item);
			yield item;
		}
	})();
}

/** 排空若干个微任务，让批内同步启动的项目全部就位 */
async function flushTicks(n = 8) {
	for (let i = 0; i < n; i++) {
		await Promise.resolve();
	}
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) {
		out.push(value);
	}
	return out;
}

/** 受测试控制的闸门：未释放时项目停在首个 await，便于观测在飞并发 */
function makeGate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

/** 单项值投影：用于需要精确控制 next 行为的场合 */
async function* singleValue(n: number): AsyncGenerator<number> {
	yield n;
}

describe("orderedParallelMap 保序产出", () => {
	it("项目乱序完成时仍按源顺序产出", async () => {
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				// 越靠前的项完成越晚，制造乱序完成
				for (let i = 0; i < 10 - n; i++) {
					await Promise.resolve();
				}
				yield n;
			};

		const got = await collect(
			orderedParallelMap([1, 2, 3, 4], project, { limit: 4 }),
		);

		expect(got).toEqual([1, 2, 3, 4]);
	});

	it("单项可产出多个结果，后项的输出不越序交付", async () => {
		const produced: string[] = [];
		const project: OrderedParallelProject<number, string> =
			async function* (n) {
				if (n === 1) {
					produced.push("a1");
					yield "a1";
					// 本项尚未完成时后项已产出，但不得越序交付
					for (let i = 0; i < 5; i++) {
						await Promise.resolve();
					}
					produced.push("a2");
					yield "a2";
				} else {
					produced.push("b1");
					yield "b1";
				}
			};

		const got = await collect(
			orderedParallelMap([1, 2], project, { limit: 2 }),
		);

		expect(got).toEqual(["a1", "a2", "b1"]);
		// b1 先于 a2 产出（后项并发跑完），交付顺序仍不越序
		expect(produced).toEqual(["a1", "b1", "a2"]);
	});

	it("项目不产出任何值时按过滤语义跳过该元素，源仍被完整消费", async () => {
		const consumed: number[] = [];
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				if (n % 2 === 1) {
					yield n;
				}
			};

		const got = await collect(
			orderedParallelMap(
				sourceOf([1, 2, 3, 4, 5], (n) => consumed.push(n)),
				project,
				{ limit: 3 },
			),
		);

		expect(got).toEqual([1, 3, 5]);
		expect(consumed).toEqual([1, 2, 3, 4, 5]);
	});

	it("接受数组（同步可迭代）与异步可迭代两种源", async () => {
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				yield n * 2;
			};

		const fromArray = await collect(
			orderedParallelMap([1, 2, 3], project, { limit: 2 }),
		);
		const fromAsync = await collect(
			orderedParallelMap(sourceOf([1, 2, 3]), project, { limit: 2 }),
		);

		expect(fromArray).toEqual([2, 4, 6]);
		expect(fromAsync).toEqual([2, 4, 6]);
	});
});

describe("orderedParallelMap 有界并发", () => {
	it("同时在飞的项目数不超过 limit", async () => {
		const { promise: gate, release } = makeGate();
		let active = 0;
		let maxActive = 0;
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate;
				active--;
				yield n;
			};

		const collecting = collect(
			orderedParallelMap(sourceOf([1, 2, 3, 4, 5, 6, 7, 8]), project, {
				limit: 3,
			}),
		);
		await flushTicks();
		// 首批 3 个同时在飞，不多不少
		expect(maxActive).toBe(3);
		release();

		expect(await collecting).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(maxActive).toBeLessThanOrEqual(3);
	});

	it("同批投影的请求被合并批合并为一次执行（合并批收益的前提）", async () => {
		// 用真实 CoalescingBatch：其收割发生在首个请求入队后的微任务。
		// 只有同批投影在该微任务之前全部入队，才会被合并为一次执行。
		const { promise: gate, release } = makeGate();
		const executed: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			async (items) => {
				executed.push([...items]);
				return items.map((i) => i);
			},
			1000,
			new AbortController().signal,
		);
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				const merged = await batch.join(n, undefined);
				await gate;
				yield merged;
			};

		const collecting = collect(
			orderedParallelMap([1, 2, 3, 4], project, { limit: 4 }),
		);
		await flushTicks();
		release();

		expect(await collecting).toEqual([1, 2, 3, 4]);
		// 同批 4 个请求合并为一次执行（而非 4 次）
		expect(executed).toEqual([[1, 2, 3, 4]]);
	});

	it("limit 为 1 时每批只有一项，合并批无法合并（并发上限与合并批宽的耦合）", async () => {
		const executed: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			async (items) => {
				executed.push([...items]);
				return items.map((i) => i);
			},
			1000,
			new AbortController().signal,
		);
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				yield await batch.join(n, undefined);
			};

		await collect(orderedParallelMap([1, 2, 3], project, { limit: 1 }));

		// 串行下每个请求各自成批——调用点取值时必须意识到这一点
		expect(executed).toEqual([[1], [2], [3]]);
	});

	it("某项未按序交付时，后续项不会无限产出（缓冲有界）", async () => {
		const { promise: gate, release } = makeGate();
		let secondProduced = 0;
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				if (n === 1) {
					await gate; // 首项阻塞，压住交付
					yield n;
					return;
				}
				for (let i = 0; i < 100; i++) {
					await Promise.resolve();
					secondProduced++;
					yield n;
				}
			};

		const iterator = orderedParallelMap([1, 2], project, {
			limit: 2,
		})[Symbol.asyncIterator]();
		const first = iterator.next();
		// 给后项充足机会「跑飞」：若缓冲无界，secondProduced 会逼近 100
		await flushTicks(50);

		expect(secondProduced).toBeLessThanOrEqual(2);

		release();
		expect((await first).value).toBe(1);
		await expect(iterator.next()).resolves.toEqual({
			done: false,
			value: 2,
		});
		await iterator.return?.(undefined);
	});

	it("limit 为 1 时逐项串行消费，行为与并发路径一致", async () => {
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				if (n % 2 === 1) {
					yield n;
				}
			};

		const serial = await collect(
			orderedParallelMap([1, 2, 3, 4, 5], project, { limit: 1 }),
		);
		const parallel = await collect(
			orderedParallelMap([1, 2, 3, 4, 5], project, { limit: 4 }),
		);

		expect(serial).toEqual(parallel);
		expect(serial).toEqual([1, 3, 5]);

		// 串行路径确实不并发
		let active = 0;
		let maxActive = 0;
		await collect(
			orderedParallelMap(
				[1, 2, 3],
				async function* (n: number) {
					active++;
					maxActive = Math.max(maxActive, active);
					await Promise.resolve();
					active--;
					yield n;
				},
				{ limit: 1 },
			),
		);
		expect(maxActive).toBe(1);
	});

	it("limit 为 1 走串行快路径：一次只取一个源元素、一次只跑一个投影", async () => {
		const consumed: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight--;
				yield n;
			};

		const got = await collect(
			orderedParallelMap(
				sourceOf([1, 2, 3, 4], (n) => consumed.push(n)),
				project,
				{ limit: 1 },
			),
		);

		expect(got).toEqual([1, 2, 3, 4]);
		expect(maxInFlight).toBe(1);
		// 串行路径逐项取源：取第 2 项时第 1 项已产出完毕
		expect(consumed).toEqual([1, 2, 3, 4]);
	});

	it("limit 为 1 时同样按序抛错、同样响应取消与中止", async () => {
		const started: number[] = [];
		const boom: OrderedParallelProject<number, number> = async function* (
			n,
		) {
			started.push(n);
			if (n === 2) {
				throw new Error("serial boom");
			}
			yield n;
		};

		const iterator = orderedParallelMap([1, 2, 3, 4], boom, {
			limit: 1,
		})[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toBe(1);
		await expect(iterator.next()).rejects.toThrow("serial boom");
		// 错误后的元素不启动
		expect(started).toEqual([1, 2]);

		const controller = new AbortController();
		const gate = new Promise<void>(() => {});
		const blocked: OrderedParallelProject<number, number> =
			async function* (n) {
				await gate;
				yield n;
			};
		const pending = orderedParallelMap([1], blocked, {
			limit: 1,
			signal: controller.signal,
		})[Symbol.asyncIterator]();
		const read = pending.next();
		controller.abort();
		await expect(read).rejects.toThrow(/abort/i);
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"limit 为 %s 时抛 RangeError",
		async (limit) => {
			const project: OrderedParallelProject<number, number> =
				async function* (n) {
					yield n;
				};
			await expect(
				collect(orderedParallelMap([1, 2], project, { limit })),
			).rejects.toThrow(RangeError);
		},
	);
});

describe("orderedParallelMap 结束与取消", () => {
	it("消费者提前结束：不再消费源并关闭在飞投影", async () => {
		const consumed: number[] = [];
		const closed: number[] = [];
		const { promise: gate, release } = makeGate();
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				try {
					await gate;
					yield n;
				} finally {
					closed.push(n);
				}
			};
		const total = 30;

		const iterator = orderedParallelMap(
			sourceOf(
				Array.from({ length: total }, (_, i) => i),
				(n) => consumed.push(n),
			),
			project,
			{ limit: 4 },
		)[Symbol.asyncIterator]();

		const first = iterator.next();
		await flushTicks();
		release();
		expect((await first).value).toBe(0);

		await iterator.return?.(undefined);
		await flushTicks();

		expect(consumed.length).toBeLessThan(total);
		// 只预取了一批（≤ limit），未扫到源结尾
		expect(consumed.length).toBeLessThanOrEqual(4);
		// 批内在飞投影全部被关闭
		expect([...closed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
	});

	it("消费者提前结束时不等在飞投影跑完（否则卸载路径会挂住）", async () => {
		// 投影永久阻塞：关闭必须立即返回，不得等它 settle
		const never = new Promise<void>(() => {});
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				await never;
				yield n;
			};

		const iterator = orderedParallelMap([1, 2, 3], project, {
			limit: 2,
		})[Symbol.asyncIterator]();
		const first = iterator.next();
		await flushTicks();

		// 不给 gate 任何释放机会：若 close 等待在飞投影，此处会超时
		const returned = await Promise.race([
			iterator.return?.(undefined).then(() => "closed"),
			new Promise((resolve) =>
				window.setTimeout(() => resolve("hung"), 200),
			),
		]);
		expect(returned).toBe("closed");

		// 消费端已结束：首次 next 不会挂住整个测试（投影仍阻塞，但无人等待其产出）
		void first.catch(() => {});
	});

	it("signal 已中止时不启动项目并抛中止错误", async () => {
		const started: number[] = [];
		const controller = new AbortController();
		controller.abort();
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				started.push(n);
				yield n;
			};

		await expect(
			collect(
				orderedParallelMap([1, 2, 3], project, {
					limit: 3,
					signal: controller.signal,
				}),
			),
		).rejects.toThrow(/abort/i);
		expect(started).toEqual([]);
	});

	it("消费途中 signal 中止时在交付点抛中止错误", async () => {
		const controller = new AbortController();
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				yield n;
			};

		const iterator = orderedParallelMap([1, 2, 3], project, {
			limit: 3,
			signal: controller.signal,
		})[Symbol.asyncIterator]();
		const pending = iterator.next();
		controller.abort();

		await expect(pending).rejects.toThrow(/abort/i);
	});
});

describe("orderedParallelMap 错误传播", () => {
	it("投影产出过程中抛错时，错误在对应槽位按源顺序抛出，后续批不启动", async () => {
		const started: number[] = [];
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				started.push(n);
				if (n === 2) {
					throw new Error("boom");
				}
				yield n;
			};

		const iterator = orderedParallelMap(sourceOf([1, 2, 3, 4]), project, {
			limit: 2,
		})[Symbol.asyncIterator]();

		// 错误项的产出不阻断其前项：先交付 1，再在 2 的槽位抛错
		expect((await iterator.next()).value).toBe(1);
		await expect(iterator.next()).rejects.toThrow("boom");
		expect(started).toEqual([1, 2]);
	});

	it("项目函数同步抛出时，错误在对应槽位抛出且其后元素不启动", async () => {
		const started: number[] = [];
		const project: OrderedParallelProject<number, number> = (n) => {
			started.push(n);
			if (n === 2) {
				throw new Error("sync boom");
			}
			return (async function* () {
				yield n;
			})();
		};

		const iterator = orderedParallelMap([1, 2, 3, 4], project, {
			limit: 4,
		})[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toBe(1);
		await expect(iterator.next()).rejects.toThrow("sync boom");
		expect(started).toEqual([1, 2]);
	});

	it("投影迭代器以非 Error 值拒绝时规范为 Error 抛出", async () => {
		// 刻意让投影迭代器的 next 以字符串拒绝：验证非 Error 拒绝值的规范化
		const nonErrorRejection: unknown = "string boom";
		const rejecting: AsyncIterableIterator<number> = {
			[Symbol.asyncIterator]() {
				return this;
			},
			// 刻意以非 Error 值拒绝，验证错误规范化
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 验证非 Error 拒绝值的规范化
			next: () => Promise.reject(nonErrorRejection),
		};
		const project: OrderedParallelProject<number, number> = (n) =>
			n === 2 ? rejecting : singleValue(n);

		const iterator = orderedParallelMap([1, 2, 3], project, {
			limit: 3,
		})[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toBe(1);
		await expect(iterator.next()).rejects.toThrow(Error);
		await expect(
			collect(orderedParallelMap([2], project, { limit: 1 })),
		).rejects.toThrow("string boom");
	});
});

describe("orderedParallelMap 副作用型调用方", () => {
	it("drain 完整消费投影并等待全部完成（产出被丢弃）", async () => {
		const done: number[] = [];
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				await Promise.resolve();
				done.push(n);
				yield n;
			};

		await drain(orderedParallelMap([1, 2, 3], project, { limit: 2 }));

		expect(done).toEqual([1, 2, 3]);
	});

	it("drain 传播投影错误", async () => {
		const project: OrderedParallelProject<number, number> =
			async function* (n) {
				if (n === 2) {
					throw new Error("drain boom");
				}
				yield n;
			};

		await expect(
			drain(orderedParallelMap([1, 2, 3], project, { limit: 2 })),
		).rejects.toThrow("drain boom");
	});
});

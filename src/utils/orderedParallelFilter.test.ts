import { describe, it, expect, vi } from "vitest";
import orderedParallelFilter from "./orderedParallelFilter";

/** 异步生成源：记录被消费（next 到达）的次数 */
function sourceOf(items: number[], onNext?: (n: number) => void) {
	return (async function* () {
		// 保留一个真实的 await 点，让测试能观测到同批谓词已并发启动
		await Promise.resolve();
		for (const item of items) {
			onNext?.(item);
			yield item;
		}
	})();
}

const flushTicks = async () => {
	// 排空若干个微任务，让批内同步启动的谓词全部就位
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of iterable) {
		out.push(v);
	}
	return out;
}

describe("orderedParallelFilter", () => {
	it("跳过不通过谓词的元素并保持源顺序", async () => {
		const predicate = vi.fn((n: number) => Promise.resolve(n % 2 === 1));
		const got = await collect(
			orderedParallelFilter(sourceOf([1, 2, 3, 4, 5]), predicate),
		);
		expect(got).toEqual([1, 3, 5]);
		// 全部元素都经过谓词判定，且按源顺序产出
		expect(predicate).toHaveBeenCalledTimes(5);
	});

	it("同一批元素并发到达（而非顺序逐条）", async () => {
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const predicate = vi.fn((_n: number) => {
			active++;
			maxActive = Math.max(maxActive, active);
			return gate.then(() => true);
		});

		const gen = orderedParallelFilter(sourceOf([1, 2, 3, 4]), predicate, {
			limit: 4,
		});
		const iterator = gen[Symbol.asyncIterator]();
		const first = iterator.next(); // 触发预取 + 同步启动本批 4 个谓词
		await flushTicks();
		// gate 尚未释放，4 个谓词都应已在飞（并发证明）
		expect(maxActive).toBeGreaterThanOrEqual(2);
		release(); // gate 释放后按源顺序产出
		expect((await first).value).toBe(1);
		// 收集剩余，验证顺序
		const rest: number[] = [];
		for await (const v of gen) {
			rest.push(v);
		}
		expect([1, ...rest]).toEqual([1, 2, 3, 4]);
	});

	it("消费者提前结束时不消耗整个源", async () => {
		const consumed: number[] = [];
		const total = 30;
		const gen = orderedParallelFilter(
			sourceOf(
				Array.from({ length: total }, (_, i) => i),
				(n) => consumed.push(n),
			),
			(_item: number) => Promise.resolve(true),
			{ limit: 4 },
		);
		const it = gen[Symbol.asyncIterator]();
		await it.next(); // item 0
		await it.next(); // item 1
		await it.return?.(undefined); // 消费者提前结束
		expect(consumed.length).toBeLessThan(total);
		// 只预取了一大批（≤ limit），未扫到源结尾
		expect(consumed.length).toBeLessThanOrEqual(4);
	});

	it("谓词随 signal 中止时向上抛中止错误", async () => {
		const ac = new AbortController();
		const abortError = Object.assign(new Error("aborted"), {
			name: "AbortError",
		});
		const predicate = vi.fn(
			(_n: number) =>
				new Promise<boolean>((_res, rej) => {
					ac.signal.addEventListener("abort", () => rej(abortError), {
						once: true,
					});
				}),
		);
		const gen = orderedParallelFilter(sourceOf([1, 2, 3]), predicate, {
			signal: ac.signal,
			limit: 3,
		});
		const it = gen[Symbol.asyncIterator]();
		const pending = it.next();
		await flushTicks();
		ac.abort();
		await expect(pending).rejects.toThrow(/abort/i);
	});
});

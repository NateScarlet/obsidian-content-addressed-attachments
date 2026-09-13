import { describe, it, expect } from "vitest";
import CoalescingBatch from "./CoalescingBatch";

/** 记录调用批次并返回逐项 double 的探针执行器 */
function probeExecutor(calls: number[][]) {
	return (items: number[]) => {
		calls.push([...items]);
		return Promise.resolve(items.map((i) => i * 2));
	};
}

describe("CoalescingBatch 内部合并批", () => {
	it("同步突发请求合并为一次执行器调用（单个事务）", async () => {
		const calls: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			probeExecutor(calls),
			1000,
			new AbortController().signal,
		);

		const results = await Promise.all([
			batch.join(1, undefined),
			batch.join(2, undefined),
			batch.join(3, undefined),
		]);

		expect(results).toEqual([2, 4, 6]);
		expect(calls).toEqual([[1, 2, 3]]);
	});

	it("达到批上限时超额部分留到下一批", async () => {
		const calls: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			probeExecutor(calls),
			3,
			new AbortController().signal,
		);

		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((i) => batch.join(i, undefined)),
		);

		expect(results).toEqual([2, 4, 6, 8, 10]);
		expect(calls).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});

	it("每个调用者拿回自己的逐项结果（didCreate 对齐）", async () => {
		const calls: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			probeExecutor(calls),
			1000,
			new AbortController().signal,
		);

		const p1 = batch.join(1, undefined);
		const p2 = batch.join(2, undefined);
		const p3 = batch.join(3, undefined);

		expect(await p1).toBe(2);
		expect(await p2).toBe(4);
		expect(await p3).toBe(6);
	});

	it("join 时已 aborted 的信号不入队、不执行", async () => {
		const calls: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			probeExecutor(calls),
			1000,
			new AbortController().signal,
		);
		const controller = new AbortController();
		controller.abort();

		await expect(batch.join(1, controller.signal)).rejects.toThrow();

		// 给微任务机会，确认没有安排收割、执行器从未被调用
		await Promise.resolve();
		expect(calls).toHaveLength(0);
	});

	it("执行前已 aborted 的请求被跳过，不影响同批其他请求", async () => {
		const calls: number[][] = [];
		const batch = new CoalescingBatch<number, number>(
			probeExecutor(calls),
			1000,
			new AbortController().signal,
		);
		const cancelled = new AbortController();

		const p1 = batch.join(1, cancelled.signal);
		cancelled.abort();
		const p2 = batch.join(2, undefined);

		await expect(p1).rejects.toThrow();
		expect(await p2).toBe(4);
		expect(calls).toEqual([[2]]);
	});

	it("批执行失败传播给全部挂靠者", async () => {
		const batch = new CoalescingBatch<number, number>(
			() => Promise.reject(new Error("boom")),
			1000,
			new AbortController().signal,
		);

		const p1 = batch.join(1, undefined);
		const p2 = batch.join(2, undefined);
		await expect(Promise.all([p1, p2])).rejects.toThrow("boom");
	});
});

describe("CoalescingBatch 合并键（keyOf）", () => {
	it("同键请求合并为一个执行条目（去重），共享同一结果", async () => {
		const calls: string[][] = [];
		const batch = new CoalescingBatch<string, number>(
			(keys) => {
				calls.push([...keys]);
				return Promise.resolve(keys.map((k) => k.length));
			},
			1000,
			new AbortController().signal,
			{ keyOf: (k) => k },
		);

		const results = await Promise.all([
			batch.join("abc", undefined),
			batch.join("abc", undefined),
			batch.join("def", undefined),
		]);

		// 同键共享结果：两个 "abc" 拿同一结果，执行器只收到去重后的条目
		expect(results).toEqual([3, 3, 3]);
		expect(calls).toEqual([["abc", "def"]]);
	});

	it("同键多个等待者共享一次执行结果（执行器只调用一次）", async () => {
		const calls: string[][] = [];
		const batch = new CoalescingBatch<string, number>(
			(keys) => {
				calls.push([...keys]);
				return Promise.resolve(keys.map((k) => k.length));
			},
			1000,
			new AbortController().signal,
			{ keyOf: (k) => k },
		);

		const results = await Promise.all([
			batch.join("abc", undefined),
			batch.join("abc", undefined),
			batch.join("abc", undefined),
		]);

		expect(results).toEqual([3, 3, 3]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["abc"]);
	});

	it("同键条目中单个 waiter 取消不影响其他 waiter", async () => {
		const batch = new CoalescingBatch<string, number>(
			(keys) => Promise.resolve(keys.map((k) => k.length)),
			1000,
			new AbortController().signal,
			{ keyOf: (k) => k },
		);
		const cancelled = new AbortController();

		const p1 = batch.join("abc", cancelled.signal);
		cancelled.abort();
		const p2 = batch.join("abc", undefined);

		await expect(p1).rejects.toThrow();
		expect(await p2).toBe(3);
	});
});

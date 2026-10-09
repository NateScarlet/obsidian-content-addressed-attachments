import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats";
import type ReferenceManager from "#src/ReferenceManager";
import isCIDReferenced from "./isCIDReferenced";

function managerWith(count: number) {
	const countFn = vi.fn(() => Promise.resolve(count));
	return {
		count: countFn,
		referenceManager: { count: countFn } as unknown as ReferenceManager,
	};
}

function aCid() {
	return CID.parse(
		"bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm",
	);
}

describe("isCIDReferenced", () => {
	it("引用计数大于 0 时视为被引用", async () => {
		const { referenceManager, count } = managerWith(1);
		expect(await isCIDReferenced(referenceManager, aCid())).toBe(true);
		expect(count).toHaveBeenCalledTimes(1);
	});

	it("引用计数为 0 时视为未被引用", async () => {
		const { referenceManager } = managerWith(0);
		expect(await isCIDReferenced(referenceManager, aCid())).toBe(false);
	});

	it("只判定存在性：计数查询上限为 1 并透传中止信号", async () => {
		const { referenceManager, count } = managerWith(2);
		const signal = new AbortController().signal;
		await isCIDReferenced(referenceManager, aCid(), signal);
		expect(count).toHaveBeenCalledWith(expect.anything(), 1, signal);
	});
});

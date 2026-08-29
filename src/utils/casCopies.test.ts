import { describe, it, expect } from "vitest";
import { mergeCopies, isCASObjectTrashed, firstTrashedAt } from "./casCopies";
import type { CASMetadataObject } from "#src/types/CASMetadata";

describe("mergeCopies 按目录合并副本状态", () => {
	it("changes 覆盖同名目录状态", () => {
		const result = mergeCopies(
			[{ dir: "a", trashedAt: new Date(1) }],
			[{ dir: "a", trashedAt: new Date(2) }],
		);
		expect(result).toEqual([{ dir: "a", trashedAt: new Date(2) }]);
	});

	it("保留未涉及的实例，同目录回收实例新增时两者并存", () => {
		const result = mergeCopies(
			[
				{ dir: "a", trashedAt: new Date(1) },
				{ dir: "b", trashedAt: undefined },
			],
			[{ dir: "b", trashedAt: new Date(2) }],
		);
		// a 的回收实例保留；b 新增回收实例后与其正常实例并存
		expect(result).toHaveLength(3);
		expect(result.find((c) => c.dir === "a")?.trashedAt?.getTime()).toBe(1);
		expect(
			result
				.filter((c) => c.dir === "b")
				.map((c) => c.trashedAt?.getTime()),
		).toContain(undefined);
		expect(
			result
				.filter((c) => c.dir === "b")
				.map((c) => c.trashedAt?.getTime()),
		).toContain(2);
	});

	it("changes 新增目录追加到结果", () => {
		const result = mergeCopies(
			[{ dir: "a", trashedAt: undefined }],
			[{ dir: "b", trashedAt: new Date(2) }],
		);
		expect(result.map((c) => c.dir).sort()).toEqual(["a", "b"]);
	});

	it("existing 为空时仅保留 changes", () => {
		const result = mergeCopies(undefined, [
			{ dir: "a", trashedAt: new Date(1) },
		]);
		expect(result).toEqual([{ dir: "a", trashedAt: new Date(1) }]);
	});

	it("changes 为空时保留原有副本状态", () => {
		const result = mergeCopies([{ dir: "a", trashedAt: new Date(1) }], []);
		expect(result).toEqual([{ dir: "a", trashedAt: new Date(1) }]);
	});

	it("同一目录可同时存在正常与回收两个实例（per-instance）", () => {
		const result = mergeCopies(
			[{ dir: "a", trashedAt: new Date(1) }],
			[{ dir: "a", trashedAt: undefined }],
		);
		expect(result).toHaveLength(2);
		expect(
			result.find((c) => c.trashedAt == null)?.trashedAt,
		).toBeUndefined();
		expect(
			result.find((c) => c.trashedAt != null)?.trashedAt?.getTime(),
		).toBe(1);
	});

	it("同实例重复出现时互相覆盖，不产生重复条目", () => {
		const result = mergeCopies(
			[{ dir: "a", trashedAt: undefined }],
			[{ dir: "a", trashedAt: undefined }],
		);
		expect(result).toEqual([{ dir: "a", trashedAt: undefined }]);
	});
});

describe("casCopies 判定函数", () => {
	it("isCASObjectTrashed 任一副本被回收即判为回收", () => {
		const obj = {
			copies: [
				{ dir: "a", trashedAt: undefined },
				{ dir: "b", trashedAt: new Date() },
			],
		} as unknown as CASMetadataObject;
		expect(isCASObjectTrashed(obj)).toBe(true);
	});

	it("isCASObjectTrashed 无回收副本返回 false", () => {
		const obj = {
			copies: [{ dir: "a", trashedAt: undefined }],
		} as unknown as CASMetadataObject;
		expect(isCASObjectTrashed(obj)).toBe(false);
	});

	it("isCASObjectTrashed 无副本返回 false", () => {
		const obj = { copies: undefined } as unknown as CASMetadataObject;
		expect(isCASObjectTrashed(obj)).toBe(false);
	});

	it("firstTrashedAt 返回最早回收时间", () => {
		const obj = {
			copies: [
				{ dir: "a", trashedAt: new Date(3) },
				{ dir: "b", trashedAt: new Date(1) },
			],
		} as unknown as CASMetadataObject;
		expect(firstTrashedAt(obj)?.getTime()).toBe(1);
	});

	it("firstTrashedAt 无回收副本返回 undefined", () => {
		const obj = {
			copies: [{ dir: "a", trashedAt: undefined }],
		} as unknown as CASMetadataObject;
		expect(firstTrashedAt(obj)).toBeUndefined();
	});
});

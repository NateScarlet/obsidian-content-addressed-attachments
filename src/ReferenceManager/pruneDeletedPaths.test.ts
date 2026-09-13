import { describe, it, expect } from "vitest";
import pruneDeletedPaths from "./pruneDeletedPaths";

describe("pruneDeletedPaths 外部删除对账差集", () => {
	it("指向已消失笔记的条目被清除", () => {
		const cachedPaths = new Set(["a.md", "b.md", "gone.md"]);
		const currentPaths = new Set(["a.md", "b.md"]);
		const pruned = pruneDeletedPaths(cachedPaths, currentPaths);
		expect(pruned).toEqual(["gone.md"]);
	});

	it("无外部删除时返回空数组", () => {
		const cachedPaths = new Set(["a.md"]);
		const currentPaths = new Set(["a.md", "new.md"]);
		expect(pruneDeletedPaths(cachedPaths, currentPaths)).toEqual([]);
	});

	it("新增笔记不影响对账（只看缓存有而当前无的）", () => {
		const cachedPaths = new Set<string>();
		const currentPaths = new Set(["new.md"]);
		expect(pruneDeletedPaths(cachedPaths, currentPaths)).toEqual([]);
	});
});

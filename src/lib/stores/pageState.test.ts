import { describe, it, expect } from "vitest";
import pageState from "./pageState";
import { Mode } from "../CASFileExplorerContext";

describe("pageState 页加载状态判定", () => {
	const aPage = { mode: Mode.LOCAL, nodes: [{ x: 1 }] };

	it("结果为空时处于加载中", () => {
		expect(pageState(Mode.LOCAL, undefined)).toEqual({
			loading: true,
			page: undefined,
		});
	});

	it("结果的模式标签与当前模式不一致时处于加载中（不显示旧 tab 内容）", () => {
		// 切到回收站，而持有的是本地模式的旧结果
		expect(pageState(Mode.RECYCLE_BIN, aPage)).toEqual({
			loading: true,
			page: undefined,
		});
	});

	it("结果模式标签与当前模式一致时已就绪，返回该页", () => {
		expect(pageState(Mode.LOCAL, aPage)).toEqual({
			loading: false,
			page: aPage,
		});
	});

	it("同一模式内重新加载（仅标签一致不因数据变而误判）", () => {
		const reloaded = { mode: Mode.LOCAL, nodes: [{ x: 2 }], cursor: "k" };
		const r = pageState(Mode.LOCAL, reloaded);
		expect(r.loading).toBe(false);
		expect(r.page).toBe(reloaded);
	});
});

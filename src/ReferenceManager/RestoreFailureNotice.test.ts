import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// 直接导入 mock 模块以获得带实例追踪的 Notice（vitest 将 "obsidian" 别名到同一文件）
import { Notice } from "#src/__mocks__/obsidian";
import RestoreFailureNotice from "./RestoreFailureNotice";

/**
 * 后台恢复失败提示的合并：按批恢复会持续高频失败，逐批弹 Notice 会刷屏，
 * 故窗口内的多次上报必须合并为一条带数量的提示（CODING_STANDARDS #3）。
 */
describe("RestoreFailureNotice", () => {
	beforeEach(() => {
		Notice.instances.length = 0;
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("窗口内的多次失败合并为一条通知，数量累加", () => {
		const notice = new RestoreFailureNotice();

		notice.report(new Error("a"));
		notice.report(new Error("b"));
		notice.report(new Error("c"));

		// 窗口未到：不派发
		expect(Notice.instances.length).toBe(0);

		vi.advanceTimersByTime(500);

		expect(Notice.instances.length).toBe(1);
		expect(Notice.instances[0].message).toContain("3");
		notice[Symbol.dispose]();
	});

	it("释放后不再派发待处理的提示", () => {
		const notice = new RestoreFailureNotice();
		notice.report(new Error("a"));

		notice[Symbol.dispose]();
		vi.advanceTimersByTime(1000);

		expect(Notice.instances.length).toBe(0);
	});
});

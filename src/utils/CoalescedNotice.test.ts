import { describe, it, expect, vi } from "vitest";
import CoalescedNotice from "./CoalescedNotice";

/** 受测的合并通知器：注入派发器与窗口后用假定时器驱动 */
function makeNotice(spy = vi.fn()) {
	return { notice: new CoalescedNotice(spy, 500), spy };
}

describe("CoalescedNotice", () => {
	it("窗口内的多次上报合并为一条通知，数量累加", () => {
		vi.useFakeTimers();
		try {
			const { notice, spy } = makeNotice();

			notice.report(1);
			notice.report(2);
			notice.report(3);

			// 窗口未到：不派发
			expect(spy).not.toHaveBeenCalled();

			vi.advanceTimersByTime(500);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("窗口结束后再次上报会重新开窗，不丢事件", () => {
		vi.useFakeTimers();
		try {
			const { notice, spy } = makeNotice();

			notice.report(1);
			vi.advanceTimersByTime(500);
			expect(spy).toHaveBeenCalledTimes(1);

			notice.report(4);
			vi.advanceTimersByTime(500);

			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy).toHaveBeenLastCalledWith(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("窗口内的新上报会重置计时，避免持续失败时提前派发", () => {
		vi.useFakeTimers();
		try {
			const { notice, spy } = makeNotice();

			notice.report(1);
			vi.advanceTimersByTime(400);
			notice.report(1);
			// 原窗口已过但被重置，未派发
			vi.advanceTimersByTime(400);
			expect(spy).not.toHaveBeenCalled();

			vi.advanceTimersByTime(100);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose 后不再派发挂起的通知（卸载时清理定时器）", () => {
		vi.useFakeTimers();
		try {
			const { notice, spy } = makeNotice();

			notice.report(1);
			notice[Symbol.dispose]();
			vi.advanceTimersByTime(1000);

			expect(spy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("上报 0 不派发空通知", () => {
		vi.useFakeTimers();
		try {
			const { notice, spy } = makeNotice();

			notice.report(0);
			vi.advanceTimersByTime(500);

			expect(spy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

import { describe, it, expect } from "vitest";
import { shouldExecuteImmediately, batchKeyOf } from "./mergeBatchPolicy";

describe("mergeBatchPolicy 引用查询合并策略", () => {
	describe("shouldExecuteImmediately（零积压零等待）", () => {
		it("没有其他挂靠请求时立即执行", () => {
			expect(shouldExecuteImmediately({ pending: 0 }, 64)).toBe(true);
		});

		it("到达的请求即当前批的第一个时立即执行", () => {
			expect(shouldExecuteImmediately({ pending: 1 }, 64)).toBe(true);
		});

		it("有其他请求挂靠且未达上限时不执行（等一个微任务再收割）", () => {
			expect(shouldExecuteImmediately({ pending: 2 }, 64)).toBe(false);
		});

		it("批达到上限时立即执行（防批无限膨胀）", () => {
			expect(shouldExecuteImmediately({ pending: 64 }, 64)).toBe(true);
		});
	});

	describe("batchKeyOf（批归属）", () => {
		it("同 skipVerify 选项共享批", () => {
			expect(batchKeyOf(true)).toBe(batchKeyOf(true));
		});

		it("不同 skipVerify 选项分属不同批（结果语义不同）", () => {
			expect(batchKeyOf(true)).not.toBe(batchKeyOf(false));
		});
	});
});

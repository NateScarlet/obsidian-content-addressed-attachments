import { Notice } from "obsidian";
import CoalescedNotice from "#src/utils/CoalescedNotice";
import defineLocales from "#src/utils/defineLocales";

/** 恢复失败提示的合并窗口（毫秒） */
const RESTORE_FAILURE_WINDOW_MS = 500;

// 定义提示消息的国际化
const { t } = defineLocales({
	en: {
		restoreFailedMsg: (count: number) =>
			`Failed to restore ${count} referenced file(s) from the recycle bin.`,
	},
	zh: {
		restoreFailedMsg: (count: number) =>
			`有 ${count} 个被引用的文件恢复失败。`,
	},
});

/**
 * 后台恢复失败的可见反馈：按批恢复会随扫描持续高频发生（万级文件 ÷ 批宽），
 * 逐批弹 Notice 会刷屏，故按窗口合并为一条带数量的提示
 * （CODING_STANDARDS #3 防抖聚合通知；与 `restoreReferencedFiles` 的成功提示、
 * `main.ts` 的补丁失败提示同一套合并机制）。
 *
 * 定时器由本类持有，构建者须在卸载时 [Symbol.dispose]（见 CODING_STANDARDS #10）。
 */
export default class RestoreFailureNotice {
	private readonly coalesced = new CoalescedNotice(
		(count) => new Notice(t("restoreFailedMsg")(count)),
		RESTORE_FAILURE_WINDOW_MS,
	);

	/**
	 * 上报一次恢复失败。以箭头属性暴露：调用方可直接传递本方法而无需绑定 this，
	 * 也无需再包一层转发函数。
	 */
	readonly report = (error: unknown): void => {
		void error;
		this.coalesced.report(1);
	};

	[Symbol.dispose](): void {
		this.coalesced[Symbol.dispose]();
	}
}

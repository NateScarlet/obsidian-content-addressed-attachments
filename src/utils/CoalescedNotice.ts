/**
 * 合并通知器：把短时间内的多次失败上报合并为一条通知，数量累加。
 *
 * 用于按 DOM 变动高频触发的场景（如页面链接补丁失败）——每个失败各弹一条会刷屏。
 * 窗口内的新上报会重置计时，持续失败时不会提前派发。
 *
 * 派发器由构建者注入（生产为 Obsidian Notice），便于测试注入空实现；
 * 定时器由本类持有，构建者须在卸载时 [Symbol.dispose]（见 CODING_STANDARDS「资源与事件清理」）。
 */
export default class CoalescedNotice {
	private pendingCount = 0;
	private timer: number | null = null;

	constructor(
		/** 通知派发器：接收窗口内累计的失败数 */
		private readonly notify: (count: number) => void,
		/** 合并窗口（毫秒） */
		private readonly windowMs: number,
	) {}

	/** 上报若干失败；窗口结束时以累计值派发一次 */
	report(count: number): void {
		if (count <= 0) {
			return;
		}
		this.pendingCount += count;
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
		}
		this.timer = window.setTimeout(() => {
			const total = this.pendingCount;
			this.pendingCount = 0;
			this.timer = null;
			if (total > 0) {
				this.notify(total);
			}
		}, this.windowMs);
	}

	[Symbol.dispose](): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.pendingCount = 0;
	}
}

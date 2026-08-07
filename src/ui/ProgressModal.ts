import { Modal, type App } from "obsidian";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		progress: "Progress",
	},
	zh: {
		progress: "进度",
	},
});

/**
 * 进度模态框。
 *
 * 调用方自行执行任务，通过 update 方法更新进度文本，
 * 通过 isCancelled 属性检查用户是否取消。
 */
export default class ProgressModal extends Modal {
	private _isCancelled = false;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private title: string,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.statusEl = this.contentEl.createEl("p", {
			text: t("progress"),
		});
	}

	get isCancelled(): boolean {
		return this._isCancelled;
	}

	/** 更新进度文本 */
	update(message: string): void {
		if (this.statusEl) {
			this.statusEl.setText(message);
		}
	}

	onClose(): void {
		this._isCancelled = true;
		this.statusEl = null;
	}
}

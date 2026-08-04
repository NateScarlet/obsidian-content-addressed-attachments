import { Modal, Notice, Setting, type App } from "obsidian";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		confirm: "Continue",
		cancel: "Cancel",
		close: "Close",
		progress: "Progress",
		confirmDialog: "Confirm operation",
		confirmMessage:
			"This will reprocess all referenced attachments in the vault. This operation is hard to revert. Continue?",
	},
	zh: {
		confirm: "继续",
		cancel: "取消",
		close: "关闭",
		progress: "进度",
		confirmDialog: "确认操作",
		confirmMessage:
			"将重新处理仓库中所有被引用的附件。此操作难以撤销。是否继续？",
	},
});

export interface ProgressController {
	readonly isCancelled: boolean;
	update(message: string): void;
}

export class ProgressModal extends Modal {
	private _isCancelled = false;
	private contentElRef: HTMLElement | null = null;
	public onCompleted: ((result: number) => void) | null = null;
	public onError: ((err: unknown) => void) | null = null;

	constructor(
		app: App,
		private title: string,
		private task: (
			progress: ProgressController,
		) => Promise<number>,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.contentElRef = this.contentEl;

		// 确认对话框
		const confirmContainer = this.contentEl.createDiv();
		confirmContainer.createEl("p", { text: t("confirmMessage") });

		new Setting(confirmContainer)
			.addButton((btn) =>
				btn.setButtonText(t("confirm")).onClick(() => {
					confirmContainer.empty();
					this.startTask();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("cancel"))
					.onClick(() => this.close()),
			);
	}

	private async startTask(): Promise<void> {
		if (!this.contentElRef) return;

		const progressEl = this.contentElRef.createDiv();
		progressEl.createEl("h3", { text: this.title });
		const statusEl = progressEl.createEl("p", { text: t("progress") });

		const controller = {
			update: (message: string) => {
				statusEl.setText(message);
			},
			get isCancelled() {
				return modalIsCancelled;
			},
		} satisfies ProgressController;
		let modalIsCancelled = false;

		try {
			const result = await this.task(controller);
			this.close();
			this.onCompleted?.(result);
		} catch (err) {
			this.close();
			this.onError?.(err);
		}
	}

	get isCancelled(): boolean {
		return this._isCancelled;
	}

	onClose(): void {
		this._isCancelled = true;
		this.contentElRef = null;
	}
}
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
		private task: (progress: ProgressController) => Promise<number>,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.contentElRef = this.contentEl;
		void this.startTask();
	}

	private async startTask(): Promise<void> {
		if (!this.contentElRef) return;

		const statusEl = this.contentElRef.createEl("p", {
			text: t("progress"),
		});

		const controller = {
			update: (message: string) => {
				statusEl.setText(message);
			},
		} as ProgressController;
		Object.defineProperty(controller, "isCancelled", {
			get: () => this.isCancelled,
		});

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

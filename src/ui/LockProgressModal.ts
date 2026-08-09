import { App, Modal } from "obsidian";
import type { LockProgress } from "../LockManager";
import LockProgressComponent from "#src/lib/LockProgress.svelte";
import { mount, unmount } from "svelte";

export class LockProgressModal extends Modal {
	/** Svelte 5 组件实例（mount 返回值，即组件 export 的字段） */
	private component?: {
		progress: LockProgress;
		isCancelled: boolean;
		error: string;
	};

	constructor(
		app: App,
		private ctr: AbortController,
	) {
		super(app);
	}

	onOpen() {
		this.component = mount(LockProgressComponent, {
			target: this.contentEl,
			props: {
				ctr: this.ctr,
				onClose: () => this.close(),
			},
		}) as LockProgressModal["component"];
	}

	onClose(): void {
		if (this.component) {
			void unmount(this.component);
		}
	}

	updateProgress(progress: LockProgress) {
		if (this.component) {
			this.component.progress = {
				...this.component.progress,
				...progress,
			};
		}
	}

	showCancelled() {
		if (this.component) {
			this.component.isCancelled = true;
		}
	}

	showError(error: string) {
		if (this.component) {
			this.component.error = error;
		}
	}
}

import { App, Modal } from "obsidian";
import type { LockProgress } from "../LockManager";
import LockProgressComponent from "src/lib/LockProgress.svelte";
import { mount, unmount } from "svelte";

export class LockProgressModal extends Modal {
	private component?: LockProgressComponent & {
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
		});
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

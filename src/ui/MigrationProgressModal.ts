import { App, Modal } from "obsidian";
import type { MigrationProgress } from "../MigrationManager";
import MigrationProgressComponent from "./MigrationProgress.svelte";
import { mount, unmount } from "svelte";

export class MigrationProgressModal extends Modal {
	private component?: MigrationProgressComponent & {
		progress: MigrationProgress;
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
		this.component = mount(MigrationProgressComponent, {
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

	updateProgress(progress: MigrationProgress) {
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

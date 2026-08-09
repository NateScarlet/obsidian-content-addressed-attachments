import { App, Modal } from "obsidian";
import type { MigrationProgress } from "../MigrationManager";
import MigrationProgressComponent from "#src/lib/MigrationProgress.svelte";
import { mount, unmount } from "svelte";

export class MigrationProgressModal extends Modal {
	/** Svelte 5 组件实例（mount 返回值，即组件 export 的字段） */
	private component?: {
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
		}) as MigrationProgressModal["component"];
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

import { Notice } from "obsidian";
import OperationProgress from "#src/lib/OperationProgress.svelte";
import { mount, unmount } from "svelte";

export default function showProgress(title: string) {
	const fragment = new DocumentFragment();
	const component = mount(OperationProgress, {
		target: fragment.createDiv(),
		props: {
			title,
		},
	});
	const notice = new Notice(fragment, 0);

	return {
		update: (currentIndex: number, currentFile?: string) => {
			component.currentIndex = currentIndex;
			if (currentFile !== undefined) {
				component.currentFile = currentFile;
			}
		},
		hide: () => {
			notice.hide();
			void unmount(component);
		},
	};
}

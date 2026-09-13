import { Notice } from "obsidian";
import OperationProgress from "#src/lib/OperationProgress.svelte";
import { mount, unmount } from "svelte";

/** 进度更新的最小间隔（毫秒）：限制 Svelte 状态写入频率，保证渲染帧可用 */
const UPDATE_INTERVAL_MS = 100;

export default function showProgress(title: string) {
	const fragment = new DocumentFragment();
	const component = mount(OperationProgress, {
		target: fragment.createDiv(),
		props: {
			title,
		},
	});
	const notice = new Notice(fragment, 0);

	// 时间基节流：高频回调（如批量重建）时只保留最新值，间隔到期时渲染一次；
	// 始终记录最新值，最后一次调用不会被吞掉
	let lastIndex = 0;
	let lastFile: string | undefined;
	let timer: number | undefined;
	const render = () => {
		timer = undefined;
		component.currentIndex = lastIndex;
		if (lastFile !== undefined) {
			component.currentFile = lastFile;
		}
	};

	return {
		update: (currentIndex: number, currentFile?: string) => {
			lastIndex = currentIndex;
			lastFile = currentFile;
			timer ??= window.setTimeout(render, UPDATE_INTERVAL_MS);
		},
		hide: () => {
			if (timer !== undefined) {
				window.clearTimeout(timer);
			}
			notice.hide();
			void unmount(component);
		},
	};
}

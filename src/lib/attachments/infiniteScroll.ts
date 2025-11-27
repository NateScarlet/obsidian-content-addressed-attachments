import { throttle } from "es-toolkit";
import createEventListeners from "src/utils/createEventListeners";
import isEventTargetScrollToEnd from "src/utils/isEventTargetScrollToEnd";
import { tick } from "svelte";

export default function infiniteScroll({
	fetchMore,
	shouldFetchMore = isEventTargetScrollToEnd,
	anchor = () => undefined,
}: {
	fetchMore: () => Promise<void> | void;
	shouldFetchMore?: (e: Event) => boolean;
	anchor?: () => HTMLElement | null | undefined;
}) {
	return function (container: HTMLElement) {
		const stack = new DisposableStack();
		stack.use(
			createEventListeners(container, (ctx) => {
				ctx.on(
					"scroll",
					throttle(async (e: Event) => {
						if (shouldFetchMore(e)) {
							const anchorEl = anchor();
							await fetchMore();
							if (anchorEl) {
								await tick();
								const el = anchorEl.offsetParent;
								if (el) {
									el.scrollTop = anchorEl.offsetTop;
									el.scrollLeft = anchorEl.offsetLeft;
								}
							}
						}
					}, 1e3),
				);
			}),
		);
		return () => {
			stack.dispose();
		};
	};
}

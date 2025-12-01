export default function textAreaAutoHeight(text: () => string) {
	return function (el: HTMLTextAreaElement) {
		$effect(() => {
			void text();
			const originalHeight = el.style.height;
			const originalOverflowY = el.style.overflowY;
			el.setCssStyles({
				height: `${el.scrollHeight}px`,
				overflowY: "hidden",
			});
			return () => {
				el.setCssStyles({
					height: originalHeight,
					overflowY: originalOverflowY,
				});
			};
		});
	};
}

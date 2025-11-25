export default function defineCustomEvent<T>(
	type: string,
	target: EventTarget = window,
) {
	function dispatch(detail: T) {
		const e = new CustomEvent(type, {
			detail: detail,
		});
		target.dispatchEvent(e);
	}
	function subscribe(
		listener: (e: CustomEvent<T>) => void,
		options?: AddEventListenerOptions,
	): () => void {
		target.addEventListener(type, listener, options);
		return () => {
			target.removeEventListener(type, listener, options);
		};
	}
	return { subscribe, dispatch };
}

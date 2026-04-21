/**
 * defineCustomEvent 定义一个类型安全的自定义事件
 * 通常应该直接共享返回的对象，仅需要和外部代码共享事件时有必要传入参数
 */
export default function defineCustomEvent<T = undefined>(
	type: string = "",
	target: EventTarget = new EventTarget(),
) {
	function dispatch(
		...args: T extends undefined
			? [init?: CustomEventInit<T>]
			: [init: { detail: T } & CustomEventInit<T>]
	): boolean;
	function dispatch(init?: CustomEventInit<T>): boolean {
		const e = new CustomEvent(type, init);
		return target.dispatchEvent(e);
	}
	function subscribe(
		listener: (e: CustomEvent<T>) => void,
		options?: AddEventListenerOptions,
	): () => void {
		target.addEventListener(type, listener as EventListener, options);
		return () => {
			target.removeEventListener(
				type,
				listener as EventListener,
				options,
			);
		};
	}
	return {
		subscribe,
		dispatch,
	};
}

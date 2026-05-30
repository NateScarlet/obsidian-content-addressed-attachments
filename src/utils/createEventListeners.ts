export default function createEventListeners<T extends EventTarget>(
	target: T,
	init: (ctx: { on: T["addEventListener"] }) => void,
): Disposable {
	const stack = new DisposableStack();
	init({
		on(...args): void {
			target.addEventListener(...args);
			stack.defer(() => target.removeEventListener(...args));
		},
	});
	return stack;
}

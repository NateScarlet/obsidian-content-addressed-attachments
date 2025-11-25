export default function createEventListeners<
	T extends {
		addEventListener: (...args: unknown[]) => void;
		removeEventListener: (...args: unknown[]) => void;
	},
>(target: T, init: (ctx: { on: T["addEventListener"] }) => void): Disposable {
	const stack = new DisposableStack();
	init({
		on(...args: unknown[]): void {
			target.addEventListener(...args);
			stack.defer(() => target.removeEventListener(...args));
		},
	});
	return stack;
}

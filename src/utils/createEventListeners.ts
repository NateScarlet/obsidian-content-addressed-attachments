export default function createEventListeners<
	T extends {
		addEventListener: (...args: any) => void;
		removeEventListener: (...args: any) => void;
	},
>(target: T, init: (ctx: { on: T["addEventListener"] }) => void): Disposable {
	const stack = new DisposableStack();
	init({
		on(...args: any[]): void {
			target.addEventListener(...args);
			stack.defer(() => target.removeEventListener(...args));
		},
	});
	return stack;
}

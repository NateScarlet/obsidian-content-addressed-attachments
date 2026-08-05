if (typeof Symbol.dispose === "undefined") {
	Object.defineProperty(Symbol, "dispose", {
		value: Symbol("Symbol.dispose"),
		configurable: false,
		writable: false,
	});
}

if (typeof Symbol.asyncDispose === "undefined") {
	Object.defineProperty(Symbol, "asyncDispose", {
		value: Symbol("Symbol.asyncDispose"),
		configurable: false,
		writable: false,
	});
}

if (typeof window.DisposableStack === "undefined") {
	class PolyfillDisposableStack {
		private disposed = false;
		private stack: Array<() => void> = [];

		use<T extends { [Symbol.dispose]?: () => void } | null | undefined>(
			value: T,
		): T {
			if (value && typeof value === "object" && Symbol.dispose in value) {
				const disposeFn = (value as Record<symbol, unknown>)[
					Symbol.dispose
				];
				if (typeof disposeFn === "function") {
					const fn = disposeFn as () => void;
					this.stack.push(() => {
						fn.call(value);
					});
				}
			}
			return value;
		}

		adopt<T>(value: T, onDispose: (value: T) => void): T {
			this.stack.push(() => onDispose(value));
			return value;
		}

		defer(onDispose: () => void): void {
			this.stack.push(onDispose);
		}

		dispose(): void {
			if (this.disposed) return;
			this.disposed = true;
			while (this.stack.length > 0) {
				const fn = this.stack.pop();
				try {
					fn?.();
				} catch (err) {
					console.error("Error during dispose:", err);
				}
			}
		}

		[Symbol.dispose](): void {
			this.dispose();
		}

		get isDisposed(): boolean {
			return this.disposed;
		}
	}

	(window as Record<string, unknown>).DisposableStack =
		PolyfillDisposableStack;
}

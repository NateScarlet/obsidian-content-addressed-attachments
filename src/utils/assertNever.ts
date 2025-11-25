export default function assertNever(...args: never[]): void {
	console.warn("assertNever", ...args);
}

import { writable } from "svelte/store";
import castError from "./castError";
import { onDestroy } from "svelte";

export default function staleWithRevalidate<T>(task: () => Promise<T>) {
	let lastResult = writable<T | undefined>();
	let lastError = writable<Error | undefined>();
	let lastVersion = 0;
	let nextVersion = 1;

	let taskStore = writable<Promise<T> | undefined>();
	function revalidate() {
		taskStore.set(task());
	}
	onDestroy(
		taskStore.subscribe((v) => {
			if (v == null) {
				return;
			}
			const version = nextVersion;
			nextVersion += 1;

			v.then((i) => {
				if (version > lastVersion) {
					lastResult.set(i);
					lastError.set(undefined);
					lastVersion = version;
				}
			}).catch((err) => {
				if (version > lastVersion) {
					lastResult.set(undefined);
					lastError.set(castError(err));
					lastVersion = version;
				}
			});
		}),
	);

	return { result: lastResult, error: lastError, revalidate };
}

import { writable } from "svelte/store";
import castError from "../../utils/castError";

export default function staleWithRevalidate<T>(
	task: () => Promise<T>,
	initialValue?: T,
) {
	const lastResult = writable<T | undefined>(initialValue);
	const lastError = writable<Error | undefined>();
	let lastVersion = 0;
	let nextVersion = 1;

	$effect(() => {
		const v = task();
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
	});
	return { result: lastResult, error: lastError };
}

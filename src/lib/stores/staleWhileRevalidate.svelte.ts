import { writable } from "svelte/store";
import castError from "../../utils/castError";

export default function staleWithRevalidate<T>(
	task: () => Promise<T>,
	initialValue?: T,
) {
	const lastResult = writable<T | undefined>(initialValue);
	const lastError = writable<Error | undefined>();
	const stale = writable(false);
	let lastVersion = 0;
	let nextVersion = 1;

	function markFresh(version: number) {
		// 还有更新的请求在途说明数据尚未追平，要等最新一次落地才结束脉冲
		if (version === nextVersion - 1) {
			stale.set(false);
		}
	}

	$effect(() => {
		const v = task();
		const version = nextVersion;
		nextVersion += 1;
		stale.set(true);

		v.then(
			(i) => {
				if (version > lastVersion) {
					lastResult.set(i);
					lastError.set(undefined);
					lastVersion = version;
				}
				markFresh(version);
			},
			(err) => {
				if (version > lastVersion) {
					lastResult.set(undefined);
					lastError.set(castError(err));
					lastVersion = version;
				}
				markFresh(version);
			},
		);
	});
	return { result: lastResult, error: lastError, isStale: stale };
}

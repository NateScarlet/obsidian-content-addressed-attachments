// @vitest-environment happy-dom
// 该 store 不碰 DOM，但 $effect.root 只在 svelte 的 client 产物里生效，
// 而 vitest 在 node 环境下按 ssr 产物编译 runes 模块，所以仍需声明 DOM 环境
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import staleWithRevalidate from "./staleWhileRevalidate.svelte";
import { effectRoot } from "../../../test/effectRoot.svelte";
import { reactiveBox } from "../../../test/reactiveBox.svelte";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const roots: Array<() => void> = [];

/**
 * 挂一个由 box 驱动的重算 store。每次重算返回队列里下一个 promise，
 * 于是「哪一次请求落地」的顺序完全由测试决定。
 */
function mount<T>(tasks: Array<ReturnType<typeof deferred<T>>>) {
	const box = reactiveBox(0);
	let call = 0;
	const { result: store, destroy } = effectRoot(() =>
		staleWithRevalidate(() => {
			void box.value;
			return tasks[call++].promise;
		}),
	);
	roots.push(destroy);
	return { store, revalidate: () => (box.value += 1) };
}

afterEach(() => {
	for (const destroy of roots.splice(0)) {
		destroy();
	}
});

describe("staleWithRevalidate 的 isStale", () => {
	it("重算进行中标记过时，落地后恢复", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const { store, revalidate } = mount([first, second]);
		await tick();

		expect(get(store.isStale)).toBe(true);

		first.resolve("a");
		await tick();

		expect(get(store.result)).toBe("a");
		expect(get(store.isStale)).toBe(false);

		revalidate();
		await tick();

		// 重算期间旧结果仍然可用，界面无需闪断
		expect(get(store.result)).toBe("a");
		expect(get(store.isStale)).toBe(true);

		second.resolve("b");
		await tick();

		expect(get(store.result)).toBe("b");
		expect(get(store.isStale)).toBe(false);
	});

	it("较旧的请求先落地时保持过时，直到最新一次重算结束", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const { store, revalidate } = mount([first, second]);
		await tick();

		revalidate();
		await tick();

		first.resolve("a");
		await tick();

		// 第二次重算仍在途，数据尚未追平
		expect(get(store.result)).toBe("a");
		expect(get(store.isStale)).toBe(true);

		second.resolve("b");
		await tick();

		expect(get(store.result)).toBe("b");
		expect(get(store.isStale)).toBe(false);
	});
});

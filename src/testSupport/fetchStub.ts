import type { RequestUrlResponse, RequestUrlResponsePromise } from "obsidian";
import { vi } from "vitest";

/** 反复让出微任务队列，观察基于 Promise 的编排是否推进到期望步骤。 */
export async function flushMicrotasks(times = 8) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

/** 构造 requestUrl 的返回值：Promise 上附带 arrayBuffer/json/text 快捷属性。 */
export function mockResponse(
	resp: RequestUrlResponse,
): RequestUrlResponsePromise {
	return Object.assign(Promise.resolve(resp), {
		arrayBuffer: Promise.resolve(resp.arrayBuffer),
		json: Promise.resolve(resp.json),
		text: Promise.resolve(resp.text),
	});
}

/** no-cors opaque response（内容不可读、status 恒 0）：任意响应都算 Host 可达。 */
export function opaqueProbeResponse(): Response {
	return { status: 0, type: "opaque" } as unknown as Response;
}

export interface FetchStub {
	/** 按发出顺序记录的全部探测调用。 */
	calls: { url: string; init: RequestInit }[];
	/** 按 URL 索引的手动控制句柄。 */
	deferreds: Map<
		string,
		{ resolve: (v: Response) => void; reject: (e: unknown) => void }
	>;
}

/** 记录并手动控制所有 fetch 探测请求；返回句柄供测试编排探测的 settle 顺序。 */
export function stubFetch(): FetchStub {
	const calls: FetchStub["calls"] = [];
	const deferreds: FetchStub["deferreds"] = new Map();
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			calls.push({ url, init: init ?? {} });
			let resolve!: (v: Response) => void;
			let reject!: (e: unknown) => void;
			const promise = new Promise<Response>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			// 模拟真实 fetch：signal 中止后 promise 以 AbortError reject
			const signal = init?.signal;
			if (signal) {
				signal.addEventListener("abort", () => {
					reject(new DOMException("Aborted", "AbortError"));
				});
			}
			promise.catch(() => {});
			deferreds.set(url, { resolve, reject });
			return promise;
		}),
	);
	return { calls, deferreds };
}

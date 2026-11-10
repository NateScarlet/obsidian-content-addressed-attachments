import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sha256 } from "multiformats/hashes/sha2";
import {
	requestUrl,
	type RequestUrlResponse,
	type RequestUrlResponsePromise,
} from "obsidian";
import openRemoteByteSource, {
	HEAD_TIMEOUT_MS,
	RANGE_CHUNK_BYTES,
	type RemoteByteSourceOptions,
} from "./openRemoteByteSource";
import {
	DownloadIntegrityError,
	WholeBodyTooLargeError,
} from "./ResolveURLError";
import type { ByteSource } from "./types/CAS";

/**
 * 下载通道选择测试：seam 为 `requestUrl`（obsidian mock）与全局 `fetch`。
 * 四支能力（fetch 流式 / HEAD 判定 / Range 循环 / 超限拒绝）各覆盖一次。
 */
describe("openRemoteByteSource", () => {
	const url = "https://gateway.example.com/ipfs/bafytest";

	function mockResponse(resp: RequestUrlResponse): RequestUrlResponsePromise {
		return Object.assign(Promise.resolve(resp), {
			arrayBuffer: Promise.resolve(resp.arrayBuffer),
			json: Promise.resolve(resp.json),
			text: Promise.resolve(resp.text),
		});
	}

	function okResponse(overrides: Partial<RequestUrlResponse> = {}) {
		return mockResponse({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: "",
			...overrides,
		});
	}

	/** 收集字节来源的全部块并拼成一份内容 */
	async function collect(source: ByteSource): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		for await (const chunk of source.open()) {
			chunks.push(chunk);
		}
		const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return merged;
	}

	/** 大块内容逐字节比较太慢，用摘要断言内容一致 */
	async function expectSameBytes(
		actual: Uint8Array,
		expected: Uint8Array,
	): Promise<void> {
		expect(actual.byteLength).toBe(expected.byteLength);
		const [actualDigest, expectedDigest] = await Promise.all([
			sha256.digest(actual),
			sha256.digest(expected),
		]);
		expect(actualDigest.bytes).toEqual(expectedDigest.bytes);
	}

	function makeContent(length: number): Uint8Array {
		const content = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			content[i] = (i * 7 + 3) % 256;
		}
		return content;
	}

	/** 用块数组构造一个只读的响应体流，可观察是否被取消 */
	function bodyStream(
		chunks: Uint8Array[],
		state: { cancelled?: boolean } = {},
	): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(chunk);
				}
				controller.close();
			},
			cancel() {
				state.cancelled = true;
			},
		});
	}

	function fetchResponse(
		options: {
			status?: number;
			contentType?: string;
			body?: ReadableStream<Uint8Array> | null;
		} = {},
	): Response {
		const headers = new Headers();
		if (options.contentType) {
			headers.set("content-type", options.contentType);
		}
		return {
			status: options.status ?? 200,
			headers,
			body: options.body ?? null,
		} as unknown as Response;
	}

	function baseOptions(
		overrides: Partial<RemoteByteSourceOptions> = {},
	): RemoteByteSourceOptions {
		return {
			url,
			headers: new Headers(),
			maxWholeBodyBytes: 32 * 1024 * 1024,
			name: "file.bin",
			...overrides,
		};
	}

	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("第 1 支：fetch 可读时直接流式读取响应体，不发 requestUrl", async () => {
		const content = makeContent(5000);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				fetchResponse({
					contentType: "video/mp4",
					body: bodyStream([
						content.subarray(0, 1024),
						content.subarray(1024),
					]),
				}),
			),
		);

		const opened = await openRemoteByteSource(baseOptions());

		expect(opened.status).toBe(200);
		expect(opened.source?.name).toBe("file.bin");
		expect(opened.source?.type).toBe("video/mp4");
		expect(opened.source?.size).toBeUndefined();
		expect(await collect(opened.source!)).toEqual(content);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("第 2/3 支：fetch 被 CORS 拦时先 HEAD 判定，再按 Range 逐块拉取", async () => {
		const content = makeContent(RANGE_CHUNK_BYTES + 10);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		const rangeHeaders: string[] = [];
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return okResponse({
					headers: {
						"accept-ranges": "bytes",
						"content-length": String(content.length),
						"content-type": "video/mp4",
					},
				});
			}
			const range =
				(typeof request === "string" ? "" : request.headers?.Range) ??
				"";
			rangeHeaders.push(range);
			const match = range.match(/^bytes=(\d+)-(\d+)$/)!;
			const start = Number(match[1]);
			const end = Math.min(Number(match[2]), content.length - 1);
			return okResponse({
				status: 206,
				headers: {
					"content-range": `bytes ${start}-${end}/${content.length}`,
					"content-type": "video/mp4",
				},
				arrayBuffer: content.slice(start, end + 1).buffer,
			});
		});

		const opened = await openRemoteByteSource(baseOptions());

		expect(opened.status).toBe(200);
		expect(opened.source?.type).toBe("video/mp4");
		// 总长从第一块的 Content-Range 得到，不需要 HEAD 的 content-length
		await expectSameBytes(await collect(opened.source!), content);
		expect(rangeHeaders).toEqual([
			`bytes=0-${RANGE_CHUNK_BYTES - 1}`,
			`bytes=${RANGE_CHUNK_BYTES}-${content.length - 1}`,
		]);
	});

	it("第 4 支：不支持 Range 且超过上限时拒绝，且不发出下载请求", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return okResponse({
					headers: { "content-length": "2048" },
				});
			}
			throw new Error("should not download");
		});

		const error = await openRemoteByteSource(
			baseOptions({ maxWholeBodyBytes: 1024 }),
		).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(WholeBodyTooLargeError);
		expect((error as WholeBodyTooLargeError).sizeBytes).toBe(2048);
		expect((error as WholeBodyTooLargeError).limitBytes).toBe(1024);
		// 只发过 HEAD：没有会带回整包 body 的请求
		expect(
			vi.mocked(requestUrl).mock.calls.filter(([request]) => {
				const method =
					typeof request === "string"
						? "GET"
						: (request.method ?? "GET");
				return method === "GET";
			}),
		).toHaveLength(0);
	});

	it("第 4 支：上限配置为 0（永不允许整包）时同样拒绝", async () => {
		const content = makeContent(10);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return okResponse({ headers: { "content-length": "10" } });
			}
			return okResponse({ arrayBuffer: content.slice().buffer });
		});

		await expect(
			openRemoteByteSource(baseOptions({ maxWholeBodyBytes: 0 })),
		).rejects.toBeInstanceOf(WholeBodyTooLargeError);
	});

	it("HEAD 失败时，永不允许整包的配置依然拒绝，不发出下载请求", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return Promise.reject(
					new Error("net::ERR_CONNECTION_REFUSED"),
				) as unknown as RequestUrlResponsePromise;
			}
			throw new Error("should not download");
		});

		const error = await openRemoteByteSource(
			baseOptions({ maxWholeBodyBytes: 0 }),
		).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(WholeBodyTooLargeError);
		// 总长未知时不能拿"未超过上限"当理由去整包缓冲
		expect((error as WholeBodyTooLargeError).sizeBytes).toBeUndefined();
		expect(
			vi.mocked(requestUrl).mock.calls.filter(([request]) => {
				const method =
					typeof request === "string"
						? "GET"
						: (request.method ?? "GET");
				return method === "GET";
			}),
		).toHaveLength(0);
	});

	it("HEAD 未给出总长且允许整包时，按现有行为整包下载", async () => {
		const content = makeContent(64);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				// 分块传输等场景没有 content-length
				return okResponse({ headers: {} });
			}
			return okResponse({ arrayBuffer: content.slice().buffer });
		});

		const opened = await openRemoteByteSource(baseOptions());

		expect(opened.status).toBe(200);
		expect(await collect(opened.source!)).toEqual(content);
	});

	it("第 4 支：未超过上限时整包下载并给出已知大小", async () => {
		const content = makeContent(2048);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return okResponse({
					headers: { "content-length": "2048" },
				});
			}
			return okResponse({
				headers: { "content-type": "application/pdf" },
				arrayBuffer: content.slice().buffer,
			});
		});

		const opened = await openRemoteByteSource(
			baseOptions({ maxWholeBodyBytes: 4096 }),
		);

		expect(opened.source?.size).toBe(2048);
		expect(opened.source?.type).toBe("application/pdf");
		expect(await collect(opened.source!)).toEqual(content);
	});

	it("HEAD 超时后把该来源判为不可用，不阻塞解析", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
			);
			vi.mocked(requestUrl).mockImplementation(
				() => new Promise(() => {}) as RequestUrlResponsePromise,
			);

			const assertion = expect(
				openRemoteByteSource(baseOptions()),
			).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(HEAD_TIMEOUT_MS);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("Range 分块边界与 Content-Range 不一致时按内容级失败", async () => {
		const content = makeContent(100);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			if (typeof request !== "string" && request.method === "HEAD") {
				return okResponse({
					headers: {
						"accept-ranges": "bytes",
						"content-length": "100",
					},
				});
			}
			return okResponse({
				status: 206,
				headers: { "content-range": "bytes 0-49/100" },
				arrayBuffer: content.slice(0, 50).buffer,
			});
		});

		const opened = await openRemoteByteSource(baseOptions());

		await expect(collect(opened.source!)).rejects.toBeInstanceOf(
			DownloadIntegrityError,
		);
	});

	it("中止信号在流式读取中途生效，并取消底层流", async () => {
		const controller = new AbortController();
		const state: { cancelled?: boolean } = {};
		let first = true;
		const content = makeContent(2048);
		const stream = new ReadableStream<Uint8Array>({
			pull(streamController) {
				if (first) {
					first = false;
					streamController.enqueue(content.subarray(0, 1024));
					return;
				}
				// 第二次读取前测试已中止：不主动 close，避免掩盖取消语义
				return new Promise(() => {});
			},
			cancel() {
				state.cancelled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(fetchResponse({ body: stream })),
		);

		const opened = await openRemoteByteSource(
			baseOptions({ signal: controller.signal }),
		);
		const iterator = opened.source!.open()[Symbol.asyncIterator]();

		const firstChunk: IteratorResult<Uint8Array, void> =
			await iterator.next();
		expect(firstChunk.value?.byteLength).toBe(1024);
		controller.abort();

		await expect(iterator.next()).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(state.cancelled).toBe(true);
	});

	it("已中止的信号在发起任何请求前就失败", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal("fetch", vi.fn());

		await expect(
			openRemoteByteSource(baseOptions({ signal: controller.signal })),
		).rejects.toMatchObject({ name: "AbortError" });
		// eslint-disable-next-line no-restricted-globals -- 断言全局 fetch 没有被调用
		expect(fetch).not.toHaveBeenCalled();
		expect(requestUrl).not.toHaveBeenCalled();
	});
});

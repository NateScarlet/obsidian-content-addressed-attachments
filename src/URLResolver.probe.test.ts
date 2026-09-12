import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { URLResolver } from "./URLResolver";
import { CID } from "multiformats/cid";
import {
	requestUrl,
	type App,
	type RequestUrlResponse,
	type RequestUrlResponsePromise,
} from "obsidian";
import type { CAS } from "./types/CAS";
import type EncryptionService from "./lib/encryption/EncryptionService";
import { getDefaultSettings, type Settings } from "./settings";

/**
 * 探测层行为测试：探测（no-cors HEAD fetch）的放行/出局/排序语义。
 * seam：URLResolver 构造边界 + 全局 fetch mock（与 requestUrl mock 同款手法）。
 */
describe("URLResolver probe", () => {
	const dummyCIDStr =
		"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

	/** 构造 requestUrl 的返回值：Promise 上附带 arrayBuffer/json/text 快捷属性。 */
	function mockResponse(resp: RequestUrlResponse): RequestUrlResponsePromise {
		return Object.assign(Promise.resolve(resp), {
			arrayBuffer: Promise.resolve(resp.arrayBuffer),
			json: Promise.resolve(resp.json),
			text: Promise.resolve(resp.text),
		});
	}

	/** 反复让出微任务队列，观察基于 Promise 的编排是否推进到期望步骤。 */
	async function flushMicrotasks(times = 8) {
		for (let i = 0; i < times; i++) {
			await Promise.resolve();
		}
	}

	/** 收集 requestUrl 收到的请求 URL（完整下载只走 requestUrl）。 */
	function getCallURLs(): string[] {
		return vi
			.mocked(requestUrl)
			.mock.calls.map(([options]) =>
				typeof options === "string" ? options : options.url,
			);
	}

	let fetchCalls: { url: string; init: RequestInit }[];
	let fetchDeferreds: Map<
		string,
		{ resolve: (v: Response) => void; reject: (e: unknown) => void }
	>;

	/** 记录并手动控制所有 fetch 探测请求；测试结束时恢复全局 fetch。 */
	function stubFetch() {
		fetchCalls = [];
		fetchDeferreds = new Map();
		vi.stubGlobal(
			"fetch",
			vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input.url;
				fetchCalls.push({ url, init: init ?? {} });
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
				fetchDeferreds.set(url, { resolve, reject });
				return promise;
			}),
		);
	}

	/** opaque response（no-cors 模式的返回值：内容不可读，status 恒 0）。 */
	function opaqueResponse(): Response {
		return { status: 0, type: "opaque" } as unknown as Response;
	}

	let mockApp: App;
	let mockCas: CAS;
	let mockEncryptionService: EncryptionService;
	let settings: Settings;
	let resolver: URLResolver;

	beforeEach(() => {
		vi.mocked(requestUrl).mockClear();
		stubFetch();
		mockApp = {
			vault: {
				adapter: {
					getResourcePath: vi.fn(
						(path: string) => `app://local/${path}`,
					),
					readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
					exists: vi.fn().mockResolvedValue(false),
				},
			},
		} as unknown as App;

		mockCas = {
			load: vi.fn().mockResolvedValue(undefined),
			lookup: vi.fn().mockImplementation(async function* () {}),
			save: vi.fn().mockResolvedValue({
				cid: CID.parse(dummyCIDStr),
				didCreate: true,
			}),
			formatRelPath: vi.fn((cid: CID) => `${cid.toString()}.data`),
			formatNormalizePath: vi.fn(
				(dir: string, cid: CID) => `${dir}/${cid.toString()}`,
			),
		} as unknown as CAS;

		mockEncryptionService = {
			ensureDecrypted: vi.fn().mockResolvedValue({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				layers: [{ header: {} }],
				toBlob: () => new Blob(["test"], { type: "image/png" }),
			}),
		} as unknown as EncryptionService;

		settings = {
			...getDefaultSettings(),
			gateways: [
				{
					name: "test-gw",
					urlTemplate:
						"https://gateway.com/ipfs/{{cid}}{{{url.pathname}}}",
					headers: [],
					enabled: true,
				},
			],
		};

		resolver = new URLResolver(
			mockApp,
			mockCas,
			() => settings,
			mockEncryptionService,
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("probe passes with any HTTP response and lets the download proceed", async () => {
		vi.mocked(requestUrl).mockImplementation(() =>
			mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			}),
		);

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();
		// 探测请求先于完整下载发出
		expect(fetchCalls).toHaveLength(1);
		const probe = fetchCalls[0];
		expect(probe.init.method).toBe("HEAD");
		expect(probe.init.mode).toBe("no-cors");
		expect(getCallURLs()).toHaveLength(0);

		// 探测收到响应（opaque，任意状态码）后放行完整下载
		fetchDeferreds
			.get(`https://gateway.com/ipfs/${dummyCIDStr}`)!
			.resolve(opaqueResponse());
		// 多轮 flush：探测 settle → flight settle → 排序 → 发起 GET → GET settle
		await flushMicrotasks(32);
		await resultPromise;

		expect(getCallURLs()).toEqual([
			`https://gateway.com/ipfs/${dummyCIDStr}`,
		]);
	});

	it("probe failure excludes the source from download", async () => {
		vi.mocked(requestUrl).mockImplementation(() => {
			throw new Error("should not be called");
		});

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();

		// 探测在网络层失败（reject）
		fetchDeferreds
			.get(`https://gateway.com/ipfs/${dummyCIDStr}`)!
			.reject(new TypeError("Failed to fetch"));
		const result = await resultPromise;

		expect(result).toBeUndefined();
		// 探测失败的来源从未发起完整下载
		expect(getCallURLs()).toHaveLength(0);
	});

	it("downloads from the probe-fastest source when multiple sources are reachable", async () => {
		settings.gateways = [
			{
				name: "gw-slow",
				urlTemplate: "https://slow.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "gw-fast",
				urlTemplate: "https://fast.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];
		// 慢来源的 GET 永不返回：首个下载成功后它不应获得下载机会
		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url.startsWith("https://slow")) {
				return new Promise(() => {}) as RequestUrlResponsePromise;
			}
			return mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			});
		});

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();
		expect(fetchCalls).toHaveLength(2);

		// 快来源探测先返回（间隔保证 RTT 排序稳定）
		fetchDeferreds
			.get(`https://fast.example.com/ipfs/${dummyCIDStr}`)!
			.resolve(opaqueResponse());
		await new Promise((r) => window.setTimeout(r, 5));
		fetchDeferreds
			.get(`https://slow.example.com/ipfs/${dummyCIDStr}`)!
			.resolve(opaqueResponse());
		await flushMicrotasks(32);

		// RTT 最快的来源先发起完整下载
		expect(getCallURLs()).toEqual([
			`https://fast.example.com/ipfs/${dummyCIDStr}`,
		]);

		// 首个下载成功：解析返回，慢来源不应有下载机会
		const result = await resultPromise;
		expect(result).toBeDefined();
		expect(getCallURLs()).toHaveLength(1);
	});

	it("starts downloading as soon as the fastest probe settles without waiting for the rest", async () => {
		settings.gateways = [
			{
				name: "gw-fast",
				urlTemplate: "https://fast.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "gw-hanging",
				urlTemplate: "https://hanging.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];
		vi.mocked(requestUrl).mockImplementation(() =>
			mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			}),
		);

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();
		expect(fetchCalls).toHaveLength(2);

		// 快来源探测 settle；挂住的来源探测永不返回
		fetchDeferreds
			.get(`https://fast.example.com/ipfs/${dummyCIDStr}`)!
			.resolve(opaqueResponse());
		await flushMicrotasks(32);

		// 不等最慢的探测：快来源已立即开始完整下载
		expect(getCallURLs()).toEqual([
			`https://fast.example.com/ipfs/${dummyCIDStr}`,
		]);

		const result = await resultPromise;
		expect(result).toBeDefined();
	});

	it("shares one probe per host across concurrent resolutions", async () => {
		vi.mocked(requestUrl).mockImplementation(() =>
			mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			}),
		);

		// 同 Host 的两次并发解析（同 CID 场景：两个元素引用同一附件）
		const first = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		const second = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();

		// 同 Host 只发出一次探测
		expect(fetchCalls).toHaveLength(1);
		fetchDeferreds
			.get(`https://gateway.com/ipfs/${dummyCIDStr}`)!
			.resolve(opaqueResponse());
		await flushMicrotasks(32);
		await Promise.all([first, second]);

		// 探测一次，完整下载也经 resolveURL 级去重合并为一次
		expect(getCallURLs()).toEqual([
			`https://gateway.com/ipfs/${dummyCIDStr}`,
		]);
	});
});

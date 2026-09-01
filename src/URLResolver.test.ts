import { describe, it, expect, vi, beforeEach } from "vitest";
import { URLResolver } from "./URLResolver";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "./lib/encryption/types";
import {
	Notice,
	requestUrl,
	type App,
	type RequestUrlResponse,
	type RequestUrlResponsePromise,
} from "obsidian";
import type { CAS } from "./types/CAS";
import type EncryptionService from "./lib/encryption/EncryptionService";
import { getDefaultSettings, type Settings } from "./settings";

describe("URLResolver", () => {
	const dummyCIDStr =
		"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
	const dummyCID = CID.parse(dummyCIDStr);

	/** 构造 requestUrl 的返回值：Promise 上附带 arrayBuffer/json/text 快捷属性。 */
	function mockResponse(resp: RequestUrlResponse): RequestUrlResponsePromise {
		return Object.assign(Promise.resolve(resp), {
			arrayBuffer: Promise.resolve(resp.arrayBuffer),
			json: Promise.resolve(resp.json),
			text: Promise.resolve(resp.text),
		});
	}

	/** 从 requestUrl 的调用记录中查找对指定 URL 的最近一次调用及其请求头。 */
	function requestCallFor(
		predicate: (url: string) => boolean,
	): { url: string; headers: Record<string, string> } | undefined {
		const calls = vi.mocked(requestUrl).mock.calls;
		for (let i = calls.length - 1; i >= 0; i--) {
			const [options] = calls[i];
			const url = typeof options === "string" ? options : options.url;
			if (predicate(url)) {
				const headers =
					typeof options === "string" ? {} : (options.headers ?? {});
				return { url, headers };
			}
		}
		return undefined;
	}

	/** Headers 会把 header 名规范化为小写，这里做大小写不敏感查找。 */
	function getHeader(
		headers: Record<string, string>,
		name: string,
	): string | undefined {
		const lower = name.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === lower) return value;
		}
		return undefined;
	}

	/** 手动控制的请求响应 Promise：与真实 requestUrl 返回类型一致，用于精确编排完成顺序。 */
	function deferred(): {
		promise: RequestUrlResponsePromise;
		resolve: (v: RequestUrlResponse) => void;
	} {
		let resolve!: (v: RequestUrlResponse) => void;
		const inner = new Promise<RequestUrlResponse>((res) => {
			resolve = res;
		});
		// 与 mockResponse 一样在 Promise 上附带快捷方法，满足 RequestUrlResponsePromise 类型
		const promise = Object.assign(inner, {
			arrayBuffer: Promise.resolve(new ArrayBuffer(0)),
			json: Promise.resolve({}),
			text: Promise.resolve(""),
		}) as RequestUrlResponsePromise;
		return { promise, resolve };
	}

	/** 反复让出微任务队列，观察基于 Promise 的编排是否推进到期望步骤。 */
	async function flushMicrotasks(times = 8) {
		for (let i = 0; i < times; i++) {
			await Promise.resolve();
		}
	}

	/** 过滤指定 HTTP 方法的 requestUrl 调用，返回其 URL 列表。 */
	function requestURLsFor(
		method: string,
		predicate: (url: string) => boolean,
	): string[] {
		return vi
			.mocked(requestUrl)
			.mock.calls.filter(([options]) => {
				const m =
					typeof options === "string"
						? "GET"
						: (options.method ?? "GET");
				if (m !== method) return false;
				const url = typeof options === "string" ? options : options.url;
				return predicate(url);
			})
			.map(([options]) =>
				typeof options === "string" ? options : options.url,
			);
	}

	/** 访问 vitest 别名注入的 Notice mock 的实例记录（真实 obsidian 类型上没有该静态成员）。 */
	function noticeInstances() {
		return (Notice as unknown as { instances: { message: string }[] })
			.instances;
	}

	let mockApp: App;
	let mockCas: CAS;
	let mockEncryptionService: EncryptionService;
	let settings: Settings;
	let resolver: URLResolver;

	beforeEach(() => {
		// 每个测试从干净的请求记录开始，避免跨用例累积影响断言
		vi.mocked(requestUrl).mockClear();
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
			save: vi.fn().mockResolvedValue({ cid: dummyCID, didCreate: true }),
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

	it("decrypts downloaded encrypted file when resolving an IPFS URL", async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": ENCRYPTED_FORMAT },
			arrayBuffer: new ArrayBuffer(16),
			json: {},
			text: "",
		});

		const rawURL = `ipfs://${dummyCIDStr}?format=${encodeURIComponent(ENCRYPTED_FORMAT)}`;
		const result = await resolver.resolveURL(rawURL);

		expect(result).toBeDefined();
		// Should have called ensureDecrypted on the downloaded payload
		// eslint-disable-next-line @typescript-eslint/unbound-method
		expect(mockEncryptionService.ensureDecrypted).toHaveBeenCalled();
		// Result URL should be a blob URL, NOT the raw ciphertext app:// URL
		expect(result?.url).toMatch(/^blob:/);
	});

	it("rejects unsupported URL protocols with a clear error", async () => {
		for (const rawURL of [
			"file:///C:/tmp/script.js",
			"ftp://example.com/script.js",
			"anyprotocol:abc",
			"C:\\tmp\\script.js",
		]) {
			await expect(resolver.resolveURL(rawURL)).rejects.toThrow(
				"Unsupported URL",
			);
		}
	});

	it("returns undefined for HTTP 404 as legitimately absent", async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 404,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: "",
		});

		const result = await resolver.resolveURL(
			"https://example.com/missing.js",
		);

		expect(result).toBeUndefined();
	});

	it("throws on unexpected HTTP status so callers see the failure", async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 500,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: "",
		});

		await expect(
			resolver.resolveURL("https://example.com/broken.js"),
		).rejects.toThrow("HTTP 500");
	});

	it("resolves a locked URL from the source directly", async () => {
		const sourceURL = "https://source.example.com/image.png";
		const lockedURL = `internal.ipfs-locked:${dummyCIDStr},${sourceURL}`;

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url === sourceURL) {
				return mockResponse({
					status: 200,
					headers: { "content-type": "image/png" },
					arrayBuffer: new ArrayBuffer(8),
					json: {},
					text: "",
				});
			}
			return mockResponse({
				status: 404,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			});
		});

		const result = await resolver.resolveURL(lockedURL);

		expect(result).toBeDefined();
		expect(result?.cid.toString()).toBe(dummyCIDStr);
		expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
			expect.objectContaining({ url: sourceURL }),
		);
	});

	it("resolves a locked URL via gateways when the source is unavailable", async () => {
		const sourceURL = "https://source.example.com/image.png";
		const lockedURL = `internal.ipfs-locked:${dummyCIDStr},${sourceURL}`;

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url === sourceURL) {
				// 源站已失效
				return mockResponse({
					status: 404,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: "",
				});
			}
			// 网关按 CID 仍可获取内容
			return mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			});
		});

		const result = await resolver.resolveURL(lockedURL);

		// 源站失效时不应直接放弃，应能通过网关解析成功
		expect(result).toBeDefined();
		expect(result?.cid.toString()).toBe(dummyCIDStr);
		// 同时请求了源站与网关
		const requestedURLs = vi
			.mocked(requestUrl)
			.mock.calls.map(([options]) =>
				typeof options === "string" ? options : options.url,
			);
		expect(requestedURLs).toContain(sourceURL);
		expect(requestedURLs).toContain(
			"https://gateway.com/ipfs/" + dummyCIDStr,
		);
	});

	/** 配置一个可达网关与一个不可达（网络级错误）网关，模拟互斥网关场景。 */
	function setupMutuallyExclusiveGateways() {
		noticeInstances().length = 0;
		settings.gateways = [
			{
				name: "internal-gw",
				urlTemplate: "https://internal.local/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "external-gw",
				urlTemplate: "https://external.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];
	}

	it("does not notify user when one source fails but another succeeds", async () => {
		setupMutuallyExclusiveGateways();

		// 内网网关不可达（网络级错误会 reject），外网网关正常返回
		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url.startsWith("https://internal.local")) {
				throw new Error("net::ERR_CONNECTION_REFUSED");
			}
			return mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			});
		});

		const result = await resolver.resolveURL(`ipfs://${dummyCIDStr}`);

		expect(result).toBeDefined();
		// 单源失败是预期内的冗余回退，不应打扰用户
		expect(noticeInstances()).toHaveLength(0);
	});

	it("shows a single notice when all sources fail", async () => {
		setupMutuallyExclusiveGateways();

		// 两个网关都不可达
		vi.mocked(requestUrl).mockRejectedValue(
			new Error("net::ERR_CONNECTION_REFUSED"),
		);

		const result = await resolver.resolveURL(`ipfs://${dummyCIDStr}`);

		expect(result).toBeUndefined();
		// 全部失败只提示一次，且带上首个错误原因
		expect(noticeInstances()).toHaveLength(1);
		expect(noticeInstances()[0].message).toContain(
			"net::ERR_CONNECTION_REFUSED",
		);
	});

	it("applies matching header rules to the locked URL source request", async () => {
		const sourceURL = "https://source.example.com/image.png";
		const lockedURL = `internal.ipfs-locked:${dummyCIDStr},${sourceURL}`;
		settings.headerRules = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]],
			},
		];

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url === sourceURL) {
				return mockResponse({
					status: 200,
					headers: { "content-type": "image/png" },
					arrayBuffer: new ArrayBuffer(8),
					json: {},
					text: "",
				});
			}
			return mockResponse({
				status: 404,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			});
		});

		const result = await resolver.resolveURL(lockedURL);

		expect(result).toBeDefined();
		const call = requestCallFor((url) => url === sourceURL);
		expect(call).toBeDefined();
		expect(getHeader(call?.headers ?? {}, "Authorization")).toBe(
			"Bearer token",
		);
	});

	it("applies global header rules to gateway requests and lets gateway headers win", async () => {
		settings.headerRules = [
			{
				baseUrl: "https://gateway.com",
				headers: [
					["Authorization", "Bearer global"],
					["X-Global", "yes"],
				],
			},
		];
		settings.gateways = [
			{
				name: "test-gw",
				urlTemplate: "https://gateway.com/ipfs/{{cid}}",
				headers: [["Authorization", "Bearer gateway"]],
				enabled: true,
			},
		];

		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "image/png" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		await resolver.resolveURL(`ipfs://${dummyCIDStr}`);

		const call = requestCallFor((url) =>
			url.startsWith("https://gateway.com/ipfs/"),
		);
		expect(call).toBeDefined();
		// 网关自身配置的同名 header 覆盖全局规则
		expect(getHeader(call?.headers ?? {}, "Authorization")).toBe(
			"Bearer gateway",
		);
		// 全局规则中未冲突的 header 附加生效
		expect(getHeader(call?.headers ?? {}, "X-Global")).toBe("yes");
	});

	it("applies matching header rules to plain HTTP resolution", async () => {
		settings.headerRules = [
			{
				baseUrl: "https://example.com",
				headers: [["X-Token", "abc"]],
			},
		];
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/plain" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		await resolver.resolveURL("https://example.com/data.txt");

		const call = requestCallFor(
			(url) => url === "https://example.com/data.txt",
		);
		expect(call).toBeDefined();
		expect(getHeader(call?.headers ?? {}, "X-Token")).toBe("abc");
	});

	it("does not apply header rules to non-matching URLs", async () => {
		settings.headerRules = [
			{
				baseUrl: "https://example.com",
				headers: [["X-Token", "abc"]],
			},
		];
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/plain" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		await resolver.resolveURL("https://other.com/data.txt");

		const call = requestCallFor(
			(url) => url === "https://other.com/data.txt",
		);
		expect(call).toBeDefined();
		expect(getHeader(call?.headers ?? {}, "X-Token")).toBeUndefined();
	});

	it("ignores header rules with an empty baseUrl", async () => {
		settings.headerRules = [
			{
				baseUrl: "",
				headers: [["X-Token", "abc"]],
			},
		];
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/plain" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		await resolver.resolveURL("https://example.com/data.txt");

		const call = requestCallFor(
			(url) => url === "https://example.com/data.txt",
		);
		expect(call).toBeDefined();
		expect(getHeader(call?.headers ?? {}, "X-Token")).toBeUndefined();
	});

	it("downloads from only the HEAD-fastest source when multiple sources are reachable", async () => {
		settings.gateways = [
			{
				name: "gw-slow",
				urlTemplate: "https://gw1.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "gw-fast",
				urlTemplate: "https://gw2.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];

		const gw1Head = deferred();
		const gw2Head = deferred();
		const gw1Get = deferred();
		const gw2Get = deferred();

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			const method =
				typeof request === "string" ? "GET" : (request.method ?? "GET");
			if (method === "HEAD") {
				if (url.startsWith("https://gw1")) return gw1Head.promise;
				if (url.startsWith("https://gw2")) return gw2Head.promise;
			}
			if (method === "GET") {
				if (url.startsWith("https://gw1")) return gw1Get.promise;
				if (url.startsWith("https://gw2")) return gw2Get.promise;
			}
			return mockResponse({
				status: 404,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			});
		});

		const okResponse = (): RequestUrlResponse => ({
			status: 200,
			headers: { "content-type": "image/png" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();

		// HEAD 更快的网关先返回
		gw2Head.resolve(okResponse());
		await flushMicrotasks();

		// 只有 HEAD 最快的网关发起了完整下载，另一个仍在 HEAD 阶段
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw2")),
		).toHaveLength(1);
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw1")),
		).toHaveLength(0);

		// 慢网关的 HEAD 稍后返回，但完整下载严格串行：不打断在飞的 GET
		gw1Head.resolve(okResponse());
		await flushMicrotasks();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw1")),
		).toHaveLength(0);

		// 第一个完整下载成功，解析结束
		gw2Get.resolve(okResponse());
		const result = await resultPromise;

		expect(result).toBeDefined();
		// 整个解析过程只发出过一个完整下载（其余测试的调用记录不在 gw 前缀下）
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw")),
		).toHaveLength(1);
	});

	it("falls back to the next source when the HEAD-fastest source fails to download", async () => {
		settings.gateways = [
			{
				name: "gw-slow",
				urlTemplate: "https://gw1.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "gw-fast",
				urlTemplate: "https://gw2.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];

		const gw1Head = deferred();
		const gw2Head = deferred();
		const gw1Get = deferred();
		const gw2Get = deferred();

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			const method =
				typeof request === "string" ? "GET" : (request.method ?? "GET");
			if (method === "HEAD") {
				if (url.startsWith("https://gw1")) return gw1Head.promise;
				if (url.startsWith("https://gw2")) return gw2Head.promise;
			}
			if (method === "GET") {
				if (url.startsWith("https://gw1")) return gw1Get.promise;
				if (url.startsWith("https://gw2")) return gw2Get.promise;
			}
			return mockResponse({
				status: 404,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			});
		});

		const okResponse = (): RequestUrlResponse => ({
			status: 200,
			headers: { "content-type": "image/png" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});
		const missingResponse = (): RequestUrlResponse => ({
			status: 404,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: "",
		});

		const resultPromise = resolver.resolveURL(`ipfs://${dummyCIDStr}`);
		await flushMicrotasks();

		// HEAD 快的网关先返回并通过预检
		gw2Head.resolve(okResponse());
		await flushMicrotasks();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw2")),
		).toHaveLength(1);

		// 慢网关 HEAD 返回，但串行：不得在快网关 GET 结果揭晓前开始下载
		gw1Head.resolve(okResponse());
		await flushMicrotasks();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw1")),
		).toHaveLength(0);

		// 快网关完整下载失败（404 视为合法缺失），才轮到慢网关
		gw2Get.resolve(missingResponse());
		await flushMicrotasks();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw1")),
		).toHaveLength(1);

		// 慢网关下载成功，解析结束
		gw1Get.resolve(okResponse());
		const result = await resultPromise;

		expect(result).toBeDefined();
		// 两个来源各发出一次完整下载，且 gw2（失败者）先于 gw1（成功者）
		const gwGetCalls: string[] = [];
		for (const [options] of vi.mocked(requestUrl).mock.calls) {
			const url = typeof options === "string" ? options : options.url;
			const method =
				typeof options === "string" ? "GET" : (options.method ?? "GET");
			if (method === "GET" && url.startsWith("https://gw")) {
				gwGetCalls.push(url);
			}
		}
		expect(gwGetCalls).toEqual([
			"https://gw2.example.com/ipfs/" + dummyCIDStr,
			"https://gw1.example.com/ipfs/" + dummyCIDStr,
		]);
	});

	it("does not download from a source whose HEAD precheck fails", async () => {
		settings.gateways = [
			{
				name: "gw1",
				urlTemplate: "https://gw1.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
			{
				name: "gw2",
				urlTemplate: "https://gw2.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			if (url.startsWith("https://gw1")) {
				// gw1 的 HEAD 预检不通过，不应有任何完整下载
				return mockResponse({
					status: 404,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: "",
				});
			}
			// gw2 预检与完整下载都正常
			return mockResponse({
				status: 200,
				headers: { "content-type": "image/png" },
				arrayBuffer: new ArrayBuffer(8),
				json: {},
				text: "",
			});
		});

		const result = await resolver.resolveURL(`ipfs://${dummyCIDStr}`);

		expect(result).toBeDefined();
		// HEAD 非 200 的来源从未发起完整下载
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw1")),
		).toHaveLength(0);
		// 预检通过的来源完成了唯一一次完整下载
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gw2")),
		).toHaveLength(1);
	});

	it("prefers the locked URL source when both source and gateway are reachable", async () => {
		const sourceURL = "https://source.example.com/image.png";
		const lockedURL = `internal.ipfs-locked:${dummyCIDStr},${sourceURL}`;
		settings.gateways = [
			{
				name: "test-gw",
				urlTemplate: "https://gateway.example.com/ipfs/{{cid}}",
				headers: [],
				enabled: true,
			},
		];

		const sourceHead = deferred();
		const sourceGet = deferred();
		const gatewayHead = deferred();
		const gatewayGet = deferred();

		vi.mocked(requestUrl).mockImplementation((request) => {
			const url = typeof request === "string" ? request : request.url;
			const method =
				typeof request === "string" ? "GET" : (request.method ?? "GET");
			if (method === "HEAD") {
				if (url === sourceURL) return sourceHead.promise;
				if (url.startsWith("https://gateway"))
					return gatewayHead.promise;
			}
			if (method === "GET") {
				if (url === sourceURL) return sourceGet.promise;
				if (url.startsWith("https://gateway"))
					return gatewayGet.promise;
			}
			return mockResponse({
				status: 404,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			});
		});

		const okResponse = (): RequestUrlResponse => ({
			status: 200,
			headers: { "content-type": "image/png" },
			arrayBuffer: new ArrayBuffer(8),
			json: {},
			text: "",
		});

		const resultPromise = resolver.resolveURL(lockedURL);
		await flushMicrotasks();

		// 源站 HEAD 先返回：源站优先获得完整下载
		sourceHead.resolve(okResponse());
		await flushMicrotasks();
		expect(requestURLsFor("GET", (url) => url === sourceURL)).toHaveLength(
			1,
		);

		// 网关 HEAD 返回，但源站 GET 在飞时网关不得开始完整下载
		gatewayHead.resolve(okResponse());
		await flushMicrotasks();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gateway")),
		).toHaveLength(0);

		// 源站下载成功，解析结束；网关从未完整下载
		sourceGet.resolve(okResponse());
		const result = await resultPromise;
		expect(result).toBeDefined();
		expect(
			requestURLsFor("GET", (url) => url.startsWith("https://gateway")),
		).toHaveLength(0);
	});
});

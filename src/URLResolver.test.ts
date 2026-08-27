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

	/** 访问 vitest 别名注入的 Notice mock 的实例记录（真实 obsidian 类型上没有该静态成员）。 */
	function noticeInstances() {
		return (
			Notice as unknown as { instances: { message: string }[] }
		).instances;
	}

	let mockApp: App;
	let mockCas: CAS;
	let mockEncryptionService: EncryptionService;
	let settings: Settings;
	let resolver: URLResolver;

	beforeEach(() => {
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
});

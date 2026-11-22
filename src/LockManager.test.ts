import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { requestUrl, type App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { SecretReader } from "#src/utils/renderHeaderValue";
import { LockManager, type LockManagerDeps } from "#src/LockManager";
import { getDefaultSettings, type Settings } from "#src/settings";

vi.mock("./ui/LockProgressModal", () => ({
	LockProgressModal: class {
		open() {}
		close() {}
		updateProgress() {}
		showCancelled() {}
		showError() {}
	},
}));

/**
 * 锁定链接迁移路径测试：通过真实 seam 驱动「下载 → 落盘 → 拼锁定链接」。
 * 流式 fetch 通道让整包 requestUrl 不应出现；整包上限用例则验证拒绝行为。
 */
describe("LockManager migration", () => {
	const cid = CID.parse(
		"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
	);
	const url = "https://source.example.com/image.png";
	const content = `before ![img](${url}) after`;
	const linkStart = content.indexOf("![");
	const linkEnd = content.indexOf(")") + 1;

	let cas: Pick<CAS, "save" | "trash" | "formatNormalizePath">;
	let readSecret: SecretReader;
	let manager: LockManager;
	let written: string | undefined;
	let fetchInit: RequestInit | undefined;
	let settingsUnderTest: Settings | undefined;

	function stubStreamFetch() {
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				fetchInit = init;
				return Promise.resolve({
					status: 200,
					headers: new Headers({ "content-type": "image/png" }),
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2, 3]));
							controller.close();
						},
					}),
				} as unknown as Response);
			}),
		);
	}

	function makeManager(
		overrides: Partial<{
			downloadDir: string;
			primaryDir: string;
			maxWholeBodyDownloadBytes: number;
		}> = {},
	) {
		const settings = {
			...getDefaultSettings(),
			downloadDir: overrides.downloadDir ?? ".attachments/downloads",
			primaryDir: overrides.primaryDir ?? ".attachments/cas",
			maxWholeBodyDownloadBytes:
				overrides.maxWholeBodyDownloadBytes ?? 1024 * 1024,
			headerRules: [
				{
					baseUrl: "https://source.example.com",
					headers: [["X-Token", "abc"] as [string, string]],
				},
			],
		};
		const app = {
			vault: {
				process: vi.fn(
					(_file: unknown, fn: (current: string) => string) => {
						written = fn(content);
						return Promise.resolve();
					},
				),
			},
		} as unknown as App;
		settingsUnderTest = settings;
		const deps: LockManagerDeps = {
			app,
			cas,
			getSettings: () => settings,
			readSecret,
		};
		return new LockManager(deps);
	}

	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
		written = undefined;
		fetchInit = undefined;
		cas = {
			save: vi.fn().mockImplementation(async () => {
				// 消费一次来源，确认交给 CAS 的是可流式读取的 ByteSource
				const source = vi.mocked(cas.save).mock.calls[0][1];
				const chunks: Uint8Array[] = [];
				for await (const chunk of source.open()) chunks.push(chunk);
				expect(chunks.flatMap((c) => [...c])).toEqual([1, 2, 3]);
				return { cid, didCreate: true };
			}),
			formatNormalizePath: vi.fn(
				(dir: string, c: CID) => `${dir}/${c.toString()}`,
			),
			trash: vi.fn().mockResolvedValue(1),
		} satisfies Pick<CAS, "save" | "trash" | "formatNormalizePath">;
		readSecret = vi.fn(() => undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const parsedLink = () => ({
		start: linkStart,
		end: linkEnd,
		original: content.slice(linkStart, linkEnd),
		link: url,
		isEmbedded: true,
	});

	it("migrates a link through the shared seam and writes the locked URL", async () => {
		stubStreamFetch();
		manager = makeManager();

		await manager.lockLink({} as never, parsedLink());

		expect(vi.mocked(requestUrl)).not.toHaveBeenCalled();
		expect(vi.mocked(cas.save)).toHaveBeenCalledWith(
			".attachments/downloads",
			expect.objectContaining({ name: "image.png" }),
		);
		expect(written).toContain(
			`internal.ipfs-locked:${cid.toString()},${url}`,
		);
		expect(written).not.toContain(`](${url})`);
	});

	it("reads the current download directory at use time, not at construction", async () => {
		stubStreamFetch();
		manager = makeManager();
		settingsUnderTest!.downloadDir = ".attachments/moved";

		await manager.lockLink({} as never, parsedLink());

		expect(vi.mocked(cas.save)).toHaveBeenCalledWith(
			".attachments/moved",
			expect.anything(),
		);
	});

	it("applies header rules to the migration download", async () => {
		stubStreamFetch();
		manager = makeManager();

		await manager.lockLink({} as never, parsedLink());

		const headers = fetchInit?.headers as Headers;
		expect(headers.get("x-token")).toBe("abc");
	});

	it("falls back to the primary directory when no download directory is set", async () => {
		stubStreamFetch();
		manager = makeManager({ downloadDir: "" });

		await manager.lockLink({} as never, parsedLink());

		expect(vi.mocked(cas.save)).toHaveBeenCalledWith(
			".attachments/cas",
			expect.anything(),
		);
	});

	it("forwards the caller's abort signal to the byte source", async () => {
		stubStreamFetch();
		manager = makeManager();
		const controller = new AbortController();

		await manager.lockLink({} as never, parsedLink(), controller.signal);

		expect(fetchInit?.signal).toBe(controller.signal);
	});

	it("refuses a whole-body download over the limit without a body request", async () => {
		// fetch 被 CORS 拦截，退回 HEAD / Range 能力探测
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			const method =
				typeof request === "string" ? "GET" : (request.method ?? "GET");
			if (method === "HEAD") {
				return Promise.resolve({
					status: 200,
					headers: { "content-length": "2048" },
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: "",
				}) as never;
			}
			throw new Error("should not issue a whole-body GET");
		});
		manager = makeManager({ maxWholeBodyDownloadBytes: 0 });

		await expect(
			manager.lockLink({} as never, parsedLink()),
		).rejects.toThrow(/limit 0/);
		expect(vi.mocked(cas.save)).not.toHaveBeenCalled();
		const getCalls = vi
			.mocked(requestUrl)
			.mock.calls.filter(([options]) =>
				typeof options === "string"
					? true
					: (options.method ?? "GET") === "GET",
			);
		expect(getCalls).toHaveLength(0);
	});

	it("surfaces an unexpected HTTP status as a readable lock error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
		);
		vi.mocked(requestUrl).mockImplementation((request) => {
			const method =
				typeof request === "string" ? "GET" : (request.method ?? "GET");
			if (method === "HEAD") {
				return Promise.resolve({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: "",
				}) as never;
			}
			return Promise.resolve({
				status: 500,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
				text: "",
			}) as never;
		});
		manager = makeManager();

		await expect(
			manager.lockLink({} as never, parsedLink()),
		).rejects.toThrow("Failed to download file: HTTP 500");
		expect(vi.mocked(cas.save)).not.toHaveBeenCalled();
	});
});

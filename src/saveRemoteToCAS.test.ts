/* eslint-disable @typescript-eslint/unbound-method -- vitest 的 mock 方法按值读取，不依赖 this */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import type { CAS, ByteSource } from "#src/types/CAS";
import type { SecretReader } from "#src/utils/renderHeaderValue";
import type { RemoteByteSourceOptions } from "#src/openRemoteByteSource";
import saveRemoteToCAS, {
	RemoteSourceUnavailableError,
} from "#src/saveRemoteToCAS";

const { mockOpenRemoteByteSource } = vi.hoisted(() => ({
	mockOpenRemoteByteSource: vi.fn(),
}));
vi.mock("#src/openRemoteByteSource", () => ({
	default: mockOpenRemoteByteSource,
}));

/**
 * 远程来源获取 seam 的契约测试。
 * 用 mock 固定 `openRemoteByteSource`：只验证 seam 的委托参数、落盘与结果拼装，
 * 通道选择本身由 openRemoteByteSource.test.ts 覆盖。
 */
describe("saveRemoteToCAS", () => {
	const cid = CID.parse(
		"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
	);
	const url = "https://source.example.com/image.png";
	const dir = ".attachments/downloads";

	let cas: CAS;
	let readSecret: SecretReader;

	/** 打开成功、内容为空的来源；块内容不是本 seam 的关注点 */
	function openedSource(): ByteSource {
		return {
			name: "image.png",
			type: "image/png",
			open: async function* () {},
		};
	}

	beforeEach(() => {
		mockOpenRemoteByteSource.mockReset();
		mockOpenRemoteByteSource.mockResolvedValue({
			status: 200,
			source: openedSource(),
		});
		cas = {
			save: vi.fn().mockResolvedValue({ cid, didCreate: true }),
			formatNormalizePath: vi.fn(
				(d: string, c: CID) => `${d}/${c.toString()}`,
			),
			trash: vi.fn().mockResolvedValue(1),
		} as unknown as CAS;
		readSecret = vi.fn(() => "resolved-secret");
	});

	it("delegates to the byte-source seam and returns cid, path and locked link", async () => {
		const source = openedSource();
		mockOpenRemoteByteSource.mockResolvedValue({ status: 200, source });

		const result = await saveRemoteToCAS(cas, {
			url,
			headerRules: [],
			readSecret,
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
			fallbackType: "image/png",
		});

		expect(mockOpenRemoteByteSource).toHaveBeenCalledWith(
			expect.objectContaining({
				url,
				signal: undefined,
				maxWholeBodyBytes: 1024,
				name: "image.png",
				fallbackType: "image/png",
			}),
		);
		const options = mockOpenRemoteByteSource.mock
			.calls[0][0] as RemoteByteSourceOptions;
		expect(options.headers).toBeInstanceOf(Headers);
		expect(cas.save).toHaveBeenCalledWith(dir, source);
		expect(cas.formatNormalizePath).toHaveBeenCalledWith(dir, cid);
		expect(result).toEqual({
			cid,
			path: `${dir}/${cid.toString()}`,
			lockedURL: `internal.ipfs-locked:${cid.toString()},${url}`,
		});
	});

	it("applies header rules first, then lets decoration headers win on the same key", async () => {
		await saveRemoteToCAS(cas, {
			url,
			headerRules: [
				{
					baseUrl: "https://source.example.com",
					headers: [
						["Authorization", "Bearer global"],
						["X-Global", "yes"],
					],
				},
			],
			readSecret,
			decorateHeaders: (headers) => {
				headers.set("Authorization", "Bearer gateway");
			},
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
		});

		const { headers } = mockOpenRemoteByteSource.mock
			.calls[0][0] as RemoteByteSourceOptions;
		expect(headers.get("authorization")).toBe("Bearer gateway");
		expect(headers.get("x-global")).toBe("yes");
	});

	it("renders secrets in matching header rules", async () => {
		await saveRemoteToCAS(cas, {
			url,
			headerRules: [
				{
					baseUrl: "https://source.example.com",
					headers: [["Authorization", "Bearer {{secrets.token}}"]],
				},
			],
			readSecret,
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
		});

		const { headers } = mockOpenRemoteByteSource.mock
			.calls[0][0] as RemoteByteSourceOptions;
		expect(readSecret).toHaveBeenCalledWith("token");
		expect(headers.get("authorization")).toBe("Bearer resolved-secret");
	});

	it("forwards the abort signal without swallowing the abort error", async () => {
		const controller = new AbortController();
		const abortError = new DOMException("Aborted", "AbortError");
		mockOpenRemoteByteSource.mockRejectedValue(abortError);

		await expect(
			saveRemoteToCAS(cas, {
				url,
				headerRules: [],
				readSecret,
				dir,
				maxWholeBodyBytes: 1024,
				name: "image.png",
				signal: controller.signal,
			}),
		).rejects.toBe(abortError);
		const options = mockOpenRemoteByteSource.mock
			.calls[0][0] as RemoteByteSourceOptions;
		expect(options.signal).toBe(controller.signal);
		expect(cas.save).not.toHaveBeenCalled();
	});

	it("throws a typed error carrying the status for non-200 responses", async () => {
		mockOpenRemoteByteSource.mockResolvedValue({ status: 503 });

		const error = await saveRemoteToCAS(cas, {
			url,
			headerRules: [],
			readSecret,
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
		}).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(RemoteSourceUnavailableError);
		expect((error as RemoteSourceUnavailableError).status).toBe(503);
		expect(String(error)).toContain("HTTP 503");
		expect(cas.save).not.toHaveBeenCalled();
	});

	it("recycles a newly created copy when the saved CID does not match the expected CID", async () => {
		const otherCID = CID.parse(
			"bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
		);
		vi.mocked(cas.save).mockResolvedValue({
			cid: otherCID,
			didCreate: true,
		});

		const result = await saveRemoteToCAS(cas, {
			url,
			headerRules: [],
			readSecret,
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
			expectedCID: cid,
		});

		expect(cas.trash).toHaveBeenCalledWith(otherCID);
		expect(result).toBeUndefined();
	});

	it("keeps a pre-existing mismatched copy instead of trashing it", async () => {
		const otherCID = CID.parse(
			"bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
		);
		vi.mocked(cas.save).mockResolvedValue({
			cid: otherCID,
			didCreate: false,
		});

		const result = await saveRemoteToCAS(cas, {
			url,
			headerRules: [],
			readSecret,
			dir,
			maxWholeBodyBytes: 1024,
			name: "image.png",
			expectedCID: cid,
		});

		expect(cas.trash).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});

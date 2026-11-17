/* eslint-disable import/no-nodejs-modules -- 测试需要 node:url 构造期望的 file: URL */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { pathToFileURL } from "node:url";
import type { ResolveURLResult } from "#src/URLResolver";
import {
	type CLIResolveDeps,
	createCLIResolveHandler,
	isSupportedCLIURL,
	resolveCLIURL,
} from "./resolveCLI";

const cid = CID.parse(
	"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
);
const rawURL = `ipfs://${cid.toString()}`;
const content = new TextEncoder().encode("hello attachment");
const contentBase64 = Buffer.from(content).toString("base64");

function resolved(overrides: Partial<ResolveURLResult> = {}): ResolveURLResult {
	return { url: "app://local/attachment", cid, ...overrides };
}

function parseOutput(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

function deps(overrides: Partial<CLIResolveDeps> = {}): CLIResolveDeps {
	return {
		resolveURL: vi.fn().mockResolvedValue(undefined),
		getFullPath: (path) => `C:/vault/${path}`,
		getMaxBlobSize: () => 20 * 1024 * 1024,
		...overrides,
	};
}

function stubFetch(bytes: Uint8Array, mime: string) {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			new Response(copy.buffer, {
				status: 200,
				headers: { "content-type": mime },
			}),
		),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isSupportedCLIURL", () => {
	it.each([
		"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
		"ipfs://cid?filename=photo.png&format=image%2Fpng",
		"internal.ipfs-locked:bafk...",
	])("接受受支持的前缀：%s", (url) => {
		expect(isSupportedCLIURL(url)).toBe(true);
	});

	it.each([
		"https://example.com/photo.png",
		"http://example.com/photo.png",
		"note/photo.png",
		"data:image/png;base64,AAAA",
		"file:///C:/photo.png",
		"ftp://example.com/photo.png",
		"",
	])("拒绝不受支持的输入：%s", (url) => {
		expect(isSupportedCLIURL(url)).toBe(false);
	});
});

describe("resolveCLIURL", () => {
	it("明文小附件输出 data: URL，内嵌解密后字节与 mime，且不输出 path", async () => {
		stubFetch(content, "image/png");
		const resolver = vi.fn().mockResolvedValue(resolved());

		const result = await resolveCLIURL(
			deps({ resolveURL: resolver }),
			rawURL,
		);

		expect(resolver).toHaveBeenCalledWith(rawURL);
		expect(result).toEqual({
			url: `data:image/png;base64,${contentBase64}`,
			cid: cid.toString(),
		});
	});

	it("加密小附件返回 blob 与密文 path 时只输出 data: URL，不泄漏密文 path", async () => {
		stubFetch(content, "image/png");
		const resolver = vi.fn().mockResolvedValue(
			resolved({
				url: "blob:app/secret",
				path: "cas/encrypted.bin",
			}),
		);

		const result = await resolveCLIURL(
			deps({ resolveURL: resolver }),
			rawURL,
		);

		expect(result.url.startsWith("data:")).toBe(true);
		expect(result).not.toHaveProperty("path");
	});

	it("大明文附件输出 file: URL 与明文文件路径", async () => {
		stubFetch(content, "application/octet-stream");
		const resolver = vi
			.fn()
			.mockResolvedValue(resolved({ path: "cas/plaintext.bin" }));

		const result = await resolveCLIURL(
			deps({ resolveURL: resolver, getMaxBlobSize: () => 4 }),
			rawURL,
		);

		expect(result.url).toBe(
			pathToFileURL("C:/vault/cas/plaintext.bin").href,
		);
		expect(result.path).toBe("cas/plaintext.bin");
	});

	it("加密大附件指向解密缓存中的明文文件", async () => {
		stubFetch(content, "image/png");
		const resolver = vi.fn().mockResolvedValue(
			resolved({
				url: "app://local/cache",
				path: "cache/bafk.decrypted",
			}),
		);

		const result = await resolveCLIURL(
			deps({ resolveURL: resolver, getMaxBlobSize: () => 4 }),
			rawURL,
		);

		expect(result.url).toBe(
			pathToFileURL("C:/vault/cache/bafk.decrypted").href,
		);
		expect(result.path).toBe("cache/bafk.decrypted");
	});

	it("不支持的 URL 直接报错且不进入 resolveURL", async () => {
		const resolver = vi.fn();

		await expect(
			resolveCLIURL(deps({ resolveURL: resolver }), "https://x/y.png"),
		).rejects.toThrow(/Unsupported URL/);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("合法缺失（无 CID）输出可读错误", async () => {
		await expect(resolveCLIURL(deps(), rawURL)).rejects.toThrow(rawURL);
	});

	it("解析返回错误占位图 data: URL 时报错，不伪装成成功内容", async () => {
		stubFetch(content, "image/svg+xml");
		const resolver = vi.fn().mockResolvedValue(
			resolved({
				url: "data:image/svg+xml;utf8,%3Csvg%3E",
			}),
		);

		await expect(
			resolveCLIURL(deps({ resolveURL: resolver }), rawURL),
		).rejects.toThrow(/placeholder|error/i);
	});

	it("读取解析结果失败时报错，不返回空 data:", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);

		await expect(
			resolveCLIURL(
				deps({
					resolveURL: vi.fn().mockResolvedValue(resolved()),
				}),
				rawURL,
			),
		).rejects.toThrow(/404/);
	});

	it("解密失败等解析错误原样向上传播", async () => {
		const resolver = vi
			.fn()
			.mockRejectedValue(new Error("decryption failed: bad key"));

		await expect(
			resolveCLIURL(deps({ resolveURL: resolver }), rawURL),
		).rejects.toThrow("decryption failed: bad key");
	});
});

describe("createCLIResolveHandler", () => {
	it("成功时 stdout 是含 url 与 cid 的单一 JSON 字符串", async () => {
		stubFetch(content, "image/png");
		const handler = createCLIResolveHandler(
			deps({
				resolveURL: vi.fn().mockResolvedValue(resolved()),
			}),
		);

		const output = await handler({ url: rawURL });

		expect(typeof output).toBe("string");
		expect(parseOutput(output)).toEqual({
			url: `data:image/png;base64,${contentBase64}`,
			cid: cid.toString(),
		});
	});

	it("缺少 url flag 时输出含 error 的 JSON", async () => {
		const resolver = vi.fn();
		const handler = createCLIResolveHandler(deps({ resolveURL: resolver }));

		const output = await handler({});

		const parsed = parseOutput(output);
		expect(parsed).toHaveProperty("error");
		expect(String(parsed.error)).toContain("url");
		expect(resolver).not.toHaveBeenCalled();
	});

	it("解析失败时输出可读错误 JSON，不含空的 data:/file: 结果", async () => {
		const handler = createCLIResolveHandler(
			deps({
				resolveURL: vi.fn().mockResolvedValue(undefined),
			}),
		);

		const output = await handler({ url: rawURL });
		const parsed = parseOutput(output);

		expect(parsed).toHaveProperty("error");
		expect(parsed.error).toContain(rawURL);
		expect(parsed).not.toHaveProperty("url");
		expect(parsed).not.toHaveProperty("path");
	});
});

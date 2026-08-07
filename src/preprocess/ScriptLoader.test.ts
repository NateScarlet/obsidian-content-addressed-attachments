import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseScriptURL } from "./ScriptLoader";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import computeCID from "#src/utils/computeCID";

/** 将 URLSearchParams 转为普通对象以便断言 */
function paramsToObject(params: URLSearchParams): Record<string, string> {
	const obj: Record<string, string> = {};
	params.forEach((value, key) => {
		obj[key] = value;
	});
	return obj;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
describe("parseScriptURL", () => {
	it("parses vault-relative path", () => {
		const result = parseScriptURL("scripts/transform.js");
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses vault-relative path with params", () => {
		const result = parseScriptURL(
			"scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("parses ipfs:// URL", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses ipfs:// URL with params", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di#format=avif",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({ format: "avif" });
	});

	it("parses internal.ipfs-locked: URL", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses internal.ipfs-locked: URL with params", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js#format=webp",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({ format: "webp" });
	});

	it("parses https:// URL", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses https:// URL with params", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("parses http:// URL", () => {
		const result = parseScriptURL(
			"http://example.com/scripts/transform.js",
		);
		expect(result).toEqual({
			type: "https",
			url: "http://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
	});

	it("returns undefined for empty string", () => {
		expect(parseScriptURL("")).toBeUndefined();
		expect(parseScriptURL("   ")).toBeUndefined();
	});

	it("returns undefined for invalid internal.ipfs-locked: URL without comma", () => {
		const result = parseScriptURL("internal.ipfs-locked:bafkreiabc123");
		expect(result).toBeUndefined();
	});

	it("returns undefined for absolute Windows path", () => {
		expect(parseScriptURL("C:\\scripts\\transform.js")).toBeUndefined();
	});

	it("returns undefined for absolute POSIX path", () => {
		expect(parseScriptURL("/scripts/transform.js")).toBeUndefined();
	});

	it("treats unknown scheme followed by path as vault-relative path", () => {
		const result = parseScriptURL("unknown:something");
		expect(result).toEqual({
			type: "vault-relative",
			path: "unknown:something",
			params: expect.any(URLSearchParams),
		});
	});
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

describe("ScriptLoaderImpl.getParams", () => {
	it("extracts params from URL fragment", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl({
			getResourcePath: (path: string) => path,
			download: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(false),
			exists: () => Promise.resolve(false),
			readFile: () => Promise.resolve(undefined),
			getPluginDir: () => "",
			resolveURL: () => Promise.resolve(undefined),
		});
		const params = loader.getParams(
			"scripts/transform.js#format=avif&quality=80",
		);
		expect(paramsToObject(params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("returns empty URLSearchParams for URL without fragment", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl({
			getResourcePath: (path: string) => path,
			download: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(false),
			exists: () => Promise.resolve(false),
			readFile: () => Promise.resolve(undefined),
			getPluginDir: () => "",
			resolveURL: () => Promise.resolve(undefined),
		});
		const params = loader.getParams("scripts/transform.js");
		expect(paramsToObject(params)).toEqual({});
	});

	it("returns empty URLSearchParams for empty string", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl({
			getResourcePath: (path: string) => path,
			download: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(false),
			exists: () => Promise.resolve(false),
			readFile: () => Promise.resolve(undefined),
			getPluginDir: () => "",
			resolveURL: () => Promise.resolve(undefined),
		});
		expect(paramsToObject(loader.getParams(""))).toEqual({});
	});
});

describe("ScriptLoaderImpl.loadScript with manifest", () => {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const fixturesDir = resolve(__dirname, "__tests__", "fixtures");
	const fixtureScriptPath = resolve(fixturesDir, "manifest-fixture.js");
	const tempDir = resolve(__dirname, "__tests__", ".temp-manifest-test");

	beforeAll(() => {
		if (!existsSync(tempDir)) {
			mkdirSync(tempDir, { recursive: true });
		}
	});

	afterAll(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("loads a multi-file script via manifest", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");

		// 读取 fixture 文件并计算 CID
		const fixtureData = readFileSync(fixtureScriptPath);
		const fixtureCID = await computeCID(
			new Uint8Array(fixtureData).buffer as ArrayBuffer,
		);

		// 动态生成 manifest 内容（使用实际 CID）
		const manifestContent = JSON.stringify({
			entry: "manifest-fixture.js",
			files: {
				"manifest-fixture.js": {
					cid: fixtureCID,
					sources: [
						"__tests__/fixtures/manifest-fixture.js",
						"https://example.com/releases/download/v0.1.0/manifest-fixture.js",
					],
				},
			},
		});

		const scriptDownloadDir = resolve(tempDir, ".script-downloads");

		// 下载目录
		if (!existsSync(scriptDownloadDir)) {
			mkdirSync(scriptDownloadDir, { recursive: true });
		}

		// 将 fixture JS 复制到下载目录（模拟 download 行为）
		const downloadPath = resolve(scriptDownloadDir, fixtureCID);
		writeFileSync(downloadPath, fixtureData);

		const loader = new ScriptLoaderImpl({
			// getResourcePath 返回 file:// URL 供 import() 使用
			getResourcePath: (path: string) => {
				// 如果是相对路径，转换为绝对路径
				if (!resolve(path) || !path.startsWith("/")) {
					// 尝试作为相对路径解析
					const absPath = resolve(tempDir, path);
					return `file:///${absPath.replace(/\\/g, "/")}`;
				}
				return `file:///${path.replace(/\\/g, "/")}`;
			},
			download: async (url: string) => {
				// 处理 vault-relative 路径和 HTTPS URL
				const colonIndex = url.indexOf(":");
				let data: Buffer;
				if (colonIndex < 0) {
					// vault-relative：从 fixture 读取
					const fullPath = resolve(__dirname, url);
					if (!existsSync(fullPath)) return undefined;
					data = readFileSync(fullPath);
				} else {
					// HTTPS：使用 fixture 文件
					data = fixtureData;
				}
				const cid = await computeCID(
					new Uint8Array(data).buffer as ArrayBuffer,
				);
				const relPath = `.script-downloads/${cid}`;
				const dlPath = resolve(scriptDownloadDir, cid);
				if (!existsSync(dlPath)) {
					writeFileSync(dlPath, data);
				}
				return { cid, path: relPath };
			},
			copy: async (cid: string, dst: string) => {
				try {
					const srcPath = resolve(scriptDownloadDir, cid);
					const dstPath = resolve(tempDir, dst);
					const dstDir = dirname(dstPath);
					if (!existsSync(dstDir)) {
						mkdirSync(dstDir, { recursive: true });
					}
					const data = readFileSync(srcPath);
					writeFileSync(dstPath, data);
					return true;
				} catch {
					return false;
				}
			},
			exists: async (path: string) => {
				return existsSync(resolve(tempDir, path));
			},
			readFile: async (path: string) => {
				// 返回动态生成的 manifest 内容
				if (path.includes("manifest-fixture.json")) {
					return manifestContent;
				}
				return undefined;
			},
			getPluginDir: () => tempDir,
			resolveURL: () => Promise.resolve(undefined),
		});

		// 使用 vault-relative 路径指向 manifest 文件
		const manifestRelPath = "__tests__/fixtures/manifest-fixture.json";
		const module = await loader.loadScript(manifestRelPath);

		// 验证模块被正确加载并包含 default 导出
		expect(module).toBeDefined();
		expect(typeof module!.default).toBe("function");
	});

	it("falls back to single-file loading for non-manifest content", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");

		const loader = new ScriptLoaderImpl({
			getResourcePath: (path: string) => {
				const absPath = resolve(__dirname, path);
				return `file:///${absPath.replace(/\\/g, "/")}`;
			},
			download: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(false),
			exists: () => Promise.resolve(false),
			readFile: async (path: string) => {
				// 返回非 JSON 内容（不是 manifest）
				const fullPath = resolve(__dirname, path);
				if (existsSync(fullPath)) {
					return readFileSync(fullPath, "utf-8");
				}
				return undefined;
			},
			getPluginDir: () => tempDir,
			resolveURL: () => Promise.resolve(undefined),
		});

		// 直接指向 JS 文件（非 manifest）
		const scriptRelPath = "__tests__/fixtures/manifest-fixture.js";
		const module = await loader.loadScript(scriptRelPath);

		// 单文件加载也应返回模块
		expect(module).toBeDefined();
		expect(typeof module!.default).toBe("function");
	});
});

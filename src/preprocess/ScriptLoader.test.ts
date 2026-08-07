import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("ScriptLoaderImpl.getParams", () => {
	it("extracts params from URL fragment", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl({
			getResourcePath: (path: string) => path,
			copy: () => Promise.resolve(),
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
			copy: () => Promise.resolve(),
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
			copy: () => Promise.resolve(),
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

		// 动态生成 manifest 内容（使用实际 CID）并写入 temp 目录
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
		const manifestPath = resolve(tempDir, "manifest-fixture.json");
		writeFileSync(manifestPath, manifestContent, "utf-8");

		// resolveURL 模拟存储（仿 CAS）
		const casStore = new Map<string, Buffer>();

		// 读取 vault-relative 文件的共享工具
		const readVaultFile = (path: string): Buffer | undefined => {
			// 优先从 temp 目录读取（manifest 在此）
			const tempPath = resolve(tempDir, path);
			if (existsSync(tempPath)) {
				return readFileSync(tempPath);
			}
			// 其次从 fixture 目录读取
			const fixturePath = resolve(__dirname, path);
			if (existsSync(fixturePath)) {
				return readFileSync(fixturePath);
			}
			return undefined;
		};

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
			readFile: async (path: string) => {
				// 从文件系统读取
				const fullPath = resolve(tempDir, path);
				if (existsSync(fullPath)) {
					return readFileSync(fullPath, "utf-8");
				}
				return undefined;
			},
			copy: async (cid: string, dst: string) => {
				const data = casStore.get(cid);
				if (!data) {
					throw new Error(`CID not found in store: ${cid}`);
				}
				const dstPath = resolve(tempDir, dst);
				const dstDir = dirname(dstPath);
				if (!existsSync(dstDir)) {
					mkdirSync(dstDir, { recursive: true });
				}
				writeFileSync(dstPath, data);
			},
			getPluginDir: () => tempDir,
			resolveURL: async (rawURL: string) => {
				// 处理 vault-relative 路径和 HTTPS URL
				const colonIndex = rawURL.indexOf(":");
				let data: Buffer | undefined;
				if (colonIndex < 0) {
					// vault-relative：从 vault 读取
					data = readVaultFile(rawURL);
					if (!data) return undefined;
				} else {
					// HTTPS：使用 fixture 文件
					data = fixtureData;
				}
				const cid = await computeCID(
					new Uint8Array(data).buffer as ArrayBuffer,
				);
				// 存储到 CAS 并写入文件系统
				if (!casStore.has(cid)) {
					casStore.set(cid, data);
					const storePath = resolve(tempDir, cid);
					writeFileSync(storePath, data);
				}
				return { cid, path: resolve(tempDir, cid) };
			},
		});

		// 使用 vault-relative 路径指向 manifest 文件
		const manifestRelPath = "manifest-fixture.json";
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
			copy: () => Promise.resolve(),
			readFile: async (path: string) => {
				const fullPath = resolve(__dirname, path);
				if (existsSync(fullPath)) {
					return readFileSync(fullPath, "utf-8");
				}
				return undefined;
			},
			getPluginDir: () => tempDir,
			resolveURL: async (rawURL: string) => {
				// vault-relative：从文件系统读取
				const fullPath = resolve(__dirname, rawURL);
				if (!existsSync(fullPath)) return undefined;
				const data = readFileSync(fullPath);
				const cid = await computeCID(
					new Uint8Array(data).buffer as ArrayBuffer,
				);
				return { cid, path: rawURL };
			},
		});

		// 直接指向 JS 文件（非 manifest）
		const scriptRelPath = "__tests__/fixtures/manifest-fixture.js";
		const module = await loader.loadScript(scriptRelPath);

		// 单文件加载也应返回模块
		expect(module).toBeDefined();
		expect(typeof module!.default).toBe("function");
	});
});

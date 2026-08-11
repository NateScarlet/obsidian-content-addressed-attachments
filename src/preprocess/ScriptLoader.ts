import type {
	ScriptLoader,
	PreProcessScriptModule,
	ScriptManifest,
} from "./types";
import type { DataAdapter } from "obsidian";
import { CID } from "multiformats/cid";
import SingleFlightGroup from "#src/utils/SingleFlightGroup";

/** 使用 URL 构造函数解析获取 params */
function parseURLSearchParams(url: string): {
	baseURL: string;
	params: URLSearchParams;
} {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) {
		return { baseURL: url, params: new URLSearchParams() };
	}
	const fragment = url.slice(hashIndex + 1);
	return {
		baseURL: url.slice(0, hashIndex),
		params: new URLSearchParams(fragment),
	};
}

/** ScriptLoader 构造函数选项 */
export interface ScriptLoaderOptions {
	/** vault DataAdapter 方法（getResourcePath / read / copy / exists / mkdir） */
	adapter: Pick<
		DataAdapter,
		"getResourcePath" | "read" | "copy" | "exists" | "mkdir"
	>;
	/** 获取插件数据目录（用于存放预处理的脚本文件） */
	pluginDir: string;
	/**
	 * 解析 URL 并下载到本地存储。
	 * 直接 resolve 就是下载，在已经本地存在时跳过下载。
	 * URL 中已经包含了可能的 cid。
	 */
	resolveURL: (
		rawURL: string,
	) => Promise<{ cid: CID; path: string } | undefined>;
}

/**
 * 递归确保目录存在（Obsidian DataAdapter.mkdir 非递归）。
 */
async function ensureDir(
	adapter: Pick<DataAdapter, "exists" | "mkdir">,
	dirPath: string,
): Promise<void> {
	const normalized = dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized || (await adapter.exists(normalized))) return;
	const parentDir = normalized.slice(0, normalized.lastIndexOf("/"));
	if (parentDir && parentDir !== normalized) {
		await ensureDir(adapter, parentDir);
	}
	try {
		await adapter.mkdir(normalized);
	} catch {
		// Ignore if created concurrently
	}
}

/**
 * DefaultScriptLoader：解析脚本位置、动态 import、缓存模块实例。
 */
export default class DefaultScriptLoader implements ScriptLoader {
	/** 模块实例缓存 */
	private moduleCache = new Map<string, PreProcessScriptModule>();
	/** 加载去重 */
	private flight = new SingleFlightGroup<
		PreProcessScriptModule | undefined
	>();

	constructor(private options: ScriptLoaderOptions) {}

	getParams(scriptURL: string): URLSearchParams {
		if (!scriptURL) return new URLSearchParams();
		const { params } = parseURLSearchParams(scriptURL);
		return params;
	}

	async loadScript(
		scriptURL: string,
	): Promise<PreProcessScriptModule | undefined> {
		if (!scriptURL) return undefined;

		// 以去除 fragment 参数的 baseURL 作为缓存键，参数变化时复用已加载的模块
		const { baseURL } = parseURLSearchParams(scriptURL);

		const cached = this.moduleCache.get(baseURL);
		if (cached) return cached;

		const { result: module, isShared } = await this.flight.do(baseURL, () =>
			this.doLoadScript(scriptURL),
		);
		if (module && !isShared) {
			this.moduleCache.set(baseURL, module);
		}
		return module;
	}

	clearCache(): void {
		this.moduleCache.clear();
	}

	private async doLoadScript(
		scriptURL: string,
	): Promise<PreProcessScriptModule | undefined> {
		try {
			const { baseURL } = parseURLSearchParams(scriptURL);
			// 所有 URL 类型统一通过 resolveURL 处理
			const resolved = await this.options.resolveURL(baseURL);
			if (!resolved?.path) return undefined;
			const localPath = resolved.path;

			// 读取文件内容，检查是否为多文件清单
			// read 对不存在的文件返回 undefined，不需要 try/catch 处理
			const content = await this.options.adapter.read(localPath);
			if (content?.trimStart().startsWith("{")) {
				const manifest = JSON.parse(content) as ScriptManifest;
				// 下载前检查清单合法：entry 必须是 files 中的 key，避免下载完才发现无效
				if (
					manifest.entry &&
					manifest.files &&
					manifest.files[manifest.entry]
				) {
					const baseDir = await this.materializeManifest(
						manifest,
						resolved.cid,
					);
					if (baseDir) {
						const entryPath = `${baseDir}/${manifest.entry}`;
						const servableURL =
							this.options.adapter.getResourcePath(entryPath);
						const cleanURL = servableURL.split("#")[0];
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method
						const mod: PreProcessScriptModule = await import(
							/* @vite-ignore */ cleanURL
						);
						return mod;
					}
					return undefined;
				}
			}

			// 普通单文件脚本
			const servableURL = this.options.adapter.getResourcePath(localPath);
			const cleanURL = servableURL.split("#")[0];
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method
			const mod: PreProcessScriptModule = await import(
				/* @vite-ignore */ cleanURL
			);
			return mod;
		} catch (err) {
			console.warn(
				`[preprocess] Failed to load script: ${scriptURL}`,
				err,
			);
			throw err instanceof Error
				? err
				: new Error(`[preprocess] Failed to load script: ${scriptURL}`);
		}
	}

	/**
	 * 下载清单中所有文件到 `<pluginDir>/preprocess-scripts/<manifestCID>/` 目录。
	 *
	 * sources 中的 URL 统一通过 resolveURL 选项处理（包括 vault-relative 路径和 HTTPS 等）。
	 * resolveURL 负责将内容下载并存储，然后通过 adapter.copy 复制到目标路径。
	 *
	 * @param manifestCID 清单文件自身的 CID（由 resolveURL 计算）
	 */
	private async materializeManifest(
		manifest: ScriptManifest,
		manifestCID: CID,
	): Promise<string | undefined> {
		const baseDir = `${this.options.pluginDir}/preprocess-scripts/${manifestCID.toString()}`;
		await ensureDir(this.options.adapter, baseDir);

		const files = manifest.files;

		for (const [filename, fileSource] of Object.entries(files)) {
			const targetPath = `${baseDir}/${filename}`;

			// 检查文件是否已存在
			const fileExists = await this.options.adapter.exists(targetPath);
			if (fileExists) {
				continue;
			}

			// 尝试从 sources 下载
			let downloaded = false;
			if (fileSource.sources) {
				for (const sourceURL of fileSource.sources) {
					const resolved = await this.options.resolveURL(sourceURL);
					if (
						resolved &&
						resolved.cid.equals(CID.parse(fileSource.cid))
					) {
						if (filename.includes("/")) {
							const targetDir = targetPath.slice(
								0,
								targetPath.lastIndexOf("/"),
							);
							await ensureDir(this.options.adapter, targetDir);
						}
						// 从 source 路径复制到目标路径
						await this.options.adapter.copy(
							resolved.path,
							targetPath,
						);
						downloaded = true;
						break;
					}
				}
			}

			if (!downloaded) {
				console.warn(
					`[preprocess] Failed to download manifest file: ${filename}`,
				);
				return undefined;
			}
		}

		// entry 已在加载清单时校验存在于 files，且随 files 循环一并下载，无需重复检查

		return baseDir;
	}
}

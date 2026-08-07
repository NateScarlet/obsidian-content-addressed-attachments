import type {
	ScriptLoader,
	PreProcessScriptModule,
	ScriptManifest,
} from "./types";
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
	/** 将 vault 路径解析为可 serve 的 URL（adapter.getResourcePath） */
	getResourcePath: (path: string) => string;
	/** 从 CAS 复制文件到目标路径，通过 CID 查找 */
	copy: (cid: string, dst: string) => Promise<void>;
	/** 读取 vault 文件内容为文本 */
	readFile: (path: string) => Promise<string | undefined>;
	/** 获取插件数据目录（用于存放预处理的脚本文件） */
	getPluginDir: () => string;
	/**
	 * 解析 URL 并下载到本地存储。
	 * 直接 resolve 就是下载，在已经本地存在时跳过下载。
	 * URL 中已经包含了可能的 cid。
	 */
	resolveURL: (
		rawURL: string,
	) => Promise<{ cid: string; path: string } | undefined>;
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

		const cached = this.moduleCache.get(scriptURL);
		if (cached) return cached;

		const { result: module, isShared } = await this.flight.do(
			scriptURL,
			() => this.doLoadScript(scriptURL),
		);
		if (module && !isShared) {
			this.moduleCache.set(scriptURL, module);
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
			// 所有 URL 类型统一通过 resolveURL 处理
			const resolved = await this.options.resolveURL(scriptURL);
			if (!resolved?.path) return undefined;
			const localPath = resolved.path;

			// 读取文件内容，检查是否为多文件清单
			const content = await this.options.readFile(localPath);
			if (content && content.trimStart().startsWith("{")) {
				const manifest = JSON.parse(content) as ScriptManifest;
				if (manifest.entry && manifest.files) {
					const baseDir = await this.materializeManifest(
						manifest,
						resolved.cid,
					);
					if (baseDir) {
						const entryPath = `${baseDir}/${manifest.entry}`;
						const servableURL =
							this.options.getResourcePath(entryPath);
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method
						const mod: PreProcessScriptModule = await import(
							/* @vite-ignore */ servableURL
						);
						return mod;
					}
					return undefined;
				}
			}

			// 普通单文件脚本
			const servableURL = this.options.getResourcePath(localPath);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method
			const mod: PreProcessScriptModule = await import(
				/* @vite-ignore */ servableURL
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
	 * resolveURL 负责将内容下载并存储，然后通过 copy 复制到目标路径。
	 *
	 * @param manifestCID 清单文件自身的 CID（由 resolveURL 计算）
	 */
	private async materializeManifest(
		manifest: ScriptManifest,
		manifestCID: string,
	): Promise<string | undefined> {
		const baseDir = `${this.options.getPluginDir()}/pre-process-scripts/${manifestCID}`;

		const entry = manifest.entry;
		const files = manifest.files;

		for (const [filename, fileSource] of Object.entries(files)) {
			const targetPath = `${baseDir}/${filename}`;

			// 检查文件是否已存在
			const targetContent = await this.options.readFile(targetPath);
			if (targetContent !== undefined) {
				continue;
			}

			// 尝试从 sources 下载
			let downloaded = false;
			if (fileSource.sources) {
				for (const sourceURL of fileSource.sources) {
					const resolved = await this.options.resolveURL(sourceURL);
					if (resolved && resolved.cid === fileSource.cid) {
						// 通过 CID 复制到目标路径
						await this.options.copy(
							resolved.cid,
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

		// 验证入口文件存在
		const entryPath = `${baseDir}/${entry}`;
		const entryContent = await this.options.readFile(entryPath);
		if (entryContent === undefined) {
			console.warn(
				`[preprocess] Manifest entry file not found: ${entryPath}`,
			);
			return undefined;
		}

		return baseDir;
	}
}

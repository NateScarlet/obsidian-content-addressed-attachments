import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type {
	ScriptLoader,
	ScriptLocation,
	PreProcessScriptModule,
	PresetManifest,
} from "./types";
import SingleFlightGroup from "#src/utils/SingleFlightGroup";

/** 已知的 URL scheme */
const KNOWN_SCHEMES = ["https:", "http:", "ipfs:", "internal.ipfs-locked:"];

/** 绝对路径前缀（Windows 和 POSIX） */
const ABSOLUTE_PATH_RE = /^[A-Za-z]:[/\\]|^\//;

/**
 * 解析脚本 URL 为 ScriptLocation。
 */
export function parseScriptURL(rawURL: string): ScriptLocation | undefined {
	const trimmed = rawURL.trim();
	if (!trimmed) return undefined;

	const colonIndex = trimmed.indexOf(":");
	if (colonIndex > 0) {
		const scheme = trimmed.slice(0, colonIndex + 1);
		if (KNOWN_SCHEMES.includes(scheme)) {
			return parseURLForm(trimmed, scheme);
		}
	}

	if (ABSOLUTE_PATH_RE.test(trimmed)) {
		return undefined;
	}

	return parseVaultRelative(trimmed);
}

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

function parseURLForm(
	rawURL: string,
	scheme: string,
): ScriptLocation | undefined {
	const { baseURL, params } = parseURLSearchParams(rawURL);

	switch (scheme) {
		case "https:":
		case "http:":
			try {
				const parsed = new URL(baseURL);
				if (
					parsed.protocol !== "http:" &&
					parsed.protocol !== "https:"
				) {
					return undefined;
				}
				return { type: "https", url: baseURL, params };
			} catch {
				return undefined;
			}
		case "ipfs:": {
			const cid = baseURL.slice("ipfs://".length);
			if (!cid) return undefined;
			return { type: "ipfs", cid, params };
		}
		case "internal.ipfs-locked:": {
			const rest = baseURL.slice("internal.ipfs-locked:".length);
			const commaIndex = rest.indexOf(",");
			if (commaIndex < 0) return undefined;
			const cid = rest.slice(0, commaIndex);
			const sourceURL = rest.slice(commaIndex + 1);
			if (!cid || !sourceURL) return undefined;
			return { type: "internal.ipfs-locked", cid, sourceURL, params };
		}
		default:
			return undefined;
	}
}

function parseVaultRelative(rawURL: string): ScriptLocation | undefined {
	const { baseURL, params } = parseURLSearchParams(rawURL);
	if (!baseURL) return undefined;
	return { type: "vault-relative", path: baseURL, params };
}

/** ScriptLoader 构造函数选项 */
export interface ScriptLoaderOptions {
	/** 将 vault 路径解析为可 serve 的 URL（adapter.getResourcePath） */
	getResourcePath: (path: string) => string;
	/** 下载远程内容到本地下载目录，返回 CID 和路径 */
	download: (
		url: string,
	) => Promise<{ cid: string; path: string } | undefined>;
	/** 从下载目录复制文件到目标路径 */
	copy: (src: string, dst: string) => Promise<boolean>;
	/** 检查 vault 路径是否存在 */
	exists: (path: string) => Promise<boolean>;
	/** 读取 vault 文件内容为文本 */
	readFile: (path: string) => Promise<string | undefined>;
	/** 获取插件数据目录（用于存放预处理的脚本文件） */
	getPluginDir: () => string;
	/** URL 解析器：将 ipfs:// 或 internal.ipfs-locked: 解析为本地路径 */
	resolveURL: (
		rawURL: string,
	) => Promise<{ path?: string; url: string } | undefined>;
}

/**
 * ScriptLoader 实现：解析脚本位置、动态 import、缓存模块实例。
 */
export default class ScriptLoaderImpl implements ScriptLoader {
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
		const location = parseScriptURL(scriptURL);
		if (!location) return undefined;

		try {
			const localPath = await this.resolveToLocalPath(location);
			if (!localPath) return undefined;

			// 读取文件内容，检查是否为多文件清单
			const content = await this.options.readFile(localPath);
			if (content && content.trimStart().startsWith("{")) {
				const manifest = JSON.parse(content) as PresetManifest;
				if (manifest.entry && manifest.files) {
					const baseDir = await this.materializeManifest(
						manifest,
						localPath,
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
			return undefined;
		}
	}

	/**
	 * 解析 ScriptLocation 为 vault 中的本地路径。
	 */
	private async resolveToLocalPath(
		location: ScriptLocation,
	): Promise<string | undefined> {
		switch (location.type) {
			case "vault-relative":
				return location.path;

			case "internal.ipfs-locked": {
				const resolved = await this.options.resolveURL(
					location.sourceURL,
				);
				if (resolved?.path) {
					return resolved.path;
				}
				// 兜底：尝试直接查找 CAS 文件
				const cidStr = location.cid;
				const prefix = cidStr.slice(0, 2);
				const suffix = cidStr.slice(2);
				const casPath = `${prefix}/${suffix}`;
				const exists = await this.options.exists(casPath);
				if (exists) {
					return casPath;
				}
				// 尝试从 sourceURL 下载
				const dlResult = await this.options.download(
					location.sourceURL,
				);
				if (dlResult) {
					return dlResult.path;
				}
				return undefined;
			}

			case "ipfs": {
				const ipfsURL = `ipfs://${location.cid}`;
				const resolved = await this.options.resolveURL(ipfsURL);
				if (resolved?.path) {
					return resolved.path;
				}
				return undefined;
			}

			case "https": {
				// HTTPS URL 总是先下载到 vault 再加载
				const dlResult = await this.options.download(location.url);
				if (dlResult) {
					return dlResult.path;
				}
				return undefined;
			}
		}
	}

	/**
	 * 计算文件内容的 CID（v1, raw codec, SHA-256）。
	 */
	private async computeCID(data: ArrayBuffer): Promise<string> {
		const digest = await sha256.digest(new Uint8Array(data));
		return CID.create(1, 0x55, digest).toString();
	}

	/**
	 * 下载清单中所有文件到 `<pluginDir>/pre-process-scripts/<manifestCID>/` 目录。
	 */
	private async materializeManifest(
		manifest: PresetManifest,
		manifestPath: string,
	): Promise<string | undefined> {
		// 计算清单文件自身的 CID 作为目录名
		const manifestContent = await this.options.readFile(manifestPath);
		if (!manifestContent) return undefined;
		const encoder = new TextEncoder();
		const manifestData = encoder.encode(manifestContent).buffer;
		const manifestCID = await this.computeCID(manifestData);
		const baseDir = `${this.options.getPluginDir()}/pre-process-scripts/${manifestCID}`;

		const entry = manifest.entry;
		const files = manifest.files;

		for (const [filename, fileSource] of Object.entries(files)) {
			const targetPath = `${baseDir}/${filename}`;

			// 检查文件是否已存在且 CID 匹配
			const exists = await this.options.exists(targetPath);
			if (exists) {
				continue;
			}

			// 尝试从 sources 下载
			let downloaded = false;
			if (fileSource.sources) {
				for (const sourceURL of fileSource.sources) {
					const dlResult = await this.options.download(sourceURL);
					if (dlResult) {
						// 验证 CID
						if (dlResult.cid === fileSource.cid) {
							// 复制到目标路径
							const copied = await this.options.copy(
								dlResult.path,
								targetPath,
							);
							if (copied) {
								downloaded = true;
								break;
							}
						}
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
		const entryExists = await this.options.exists(entryPath);
		if (!entryExists) {
			console.warn(
				`[preprocess] Manifest entry file not found: ${entryPath}`,
			);
			return undefined;
		}

		return baseDir;
	}
}

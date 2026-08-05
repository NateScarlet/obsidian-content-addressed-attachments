import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type {
	ScriptLoader,
	ScriptLocation,
	PreProcessScriptModule,
	PresetManifest,
} from "./types";

/** 已知的 URL scheme */
const KNOWN_SCHEMES = ["https:", "http:", "ipfs:", "internal.ipfs-locked:"];

/** 绝对路径前缀（Windows 和 POSIX） */
const ABSOLUTE_PATH_RE = /^[A-Za-z]:[/\\]|^\//;

/**
 * 解析脚本 URL 为 ScriptLocation。
 * 规则：如果第一个冒号分隔的段是已知 scheme 之一，则为 URL 形式；否则为 vault 相对路径。
 * vault 相对路径不允许以绝对路径前缀开头。
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

	// 放行绝对路径（如 C:\path 或 /path）
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
			// 使用标准 URL 构造函数验证
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

/**
 * ScriptLoader 实现：解析脚本位置、动态 import、缓存模块实例。
 *
 * 依赖注入友好：接收 resolveURL 函数将 ipfs:// 等 URL 解析为本地路径，
 * 接收 getResourcePath 将 vault 路径转换为可 serve 的 URL。
 *
 * HTTPS URL 总是先下载到本地再通过 getResourcePath 加载（锁定行为由 LockManager 负责）。
 */
export default class ScriptLoaderImpl implements ScriptLoader {
	/** 模块实例缓存 */
	private moduleCache = new Map<string, PreProcessScriptModule>();
	/** 加载中的 Promise 去重（SingleFlight） */
	private pendingLoads = new Map<
		string,
		Promise<PreProcessScriptModule | undefined>
	>();

	constructor(
		/** 将 vault 路径解析为可 serve 的 URL（adapter.getResourcePath） */
		private getResourcePath: (path: string) => string,
		/** 下载远程内容到本地并返回本地路径 */
		private downloadToVault: (
			url: string,
			filename: string,
		) => Promise<string | undefined>,
		/** 检查 vault 路径是否存在 */
		private exists: (path: string) => Promise<boolean>,
		/** 读取 vault 文件内容为文本 */
		private readFile: (path: string) => Promise<string | undefined>,
		/** 获取下载目录 */
		private getDownloadDir: () => string,
		/** 获取主存储目录 */
		private getPrimaryDir: () => string,
		/** 获取插件数据目录（用于存放预处理的脚本文件） */
		private getPluginDir: () => string,
		/** URL 解析器：将 ipfs:// 或 internal.ipfs-locked: 解析为本地路径 */
		private resolveURL: (
			rawURL: string,
		) => Promise<{ path?: string; url: string } | undefined>,
	) {}

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

		const pending = this.pendingLoads.get(scriptURL);
		if (pending) return pending;

		const loadPromise = this.doLoadScript(scriptURL);
		this.pendingLoads.set(scriptURL, loadPromise);
		try {
			const module = await loadPromise;
			if (module) {
				this.moduleCache.set(scriptURL, module);
			}
			return module;
		} finally {
			this.pendingLoads.delete(scriptURL);
		}
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
			const content = await this.readFile(localPath);
			if (content && content.trimStart().startsWith("{")) {
				const manifest = JSON.parse(content) as PresetManifest;
				if (manifest.entry && manifest.files) {
					const baseDir = await this.materializeManifest(
						manifest,
						location,
					);
					if (baseDir) {
						const entryPath = `${baseDir}/${manifest.entry}`;
						const servableURL = this.getResourcePath(entryPath);
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
			const servableURL = this.getResourcePath(localPath);
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
	 * 返回的是 vault 相对路径，而非可 serve 的 URL。
	 */
	private async resolveToLocalPath(
		location: ScriptLocation,
	): Promise<string | undefined> {
		switch (location.type) {
			case "vault-relative":
				return location.path;

			case "internal.ipfs-locked": {
				// 先尝试 URLResolver 解析到本地路径
				const resolved = await this.resolveURL(location.sourceURL);
				if (resolved?.path) {
					return resolved.path;
				}
				// 兜底：尝试直接查找 CAS 文件
				const dir = this.getPrimaryDir();
				const cidStr = location.cid;
				const prefix = cidStr.slice(0, 2);
				const suffix = cidStr.slice(2);
				const casPath = `${dir}/${prefix}/${suffix}`;
				const exists = await this.exists(casPath);
				if (exists) {
					return casPath;
				}
				// 尝试从 sourceURL 下载
				const dlPath = await this.downloadToVault(
					location.sourceURL,
					`${this.getDownloadDir() || dir}/${cidStr}.js`,
				);
				if (dlPath) {
					return dlPath;
				}
				return undefined;
			}

			case "ipfs": {
				const ipfsURL = `ipfs://${location.cid}`;
				const resolved = await this.resolveURL(ipfsURL);
				if (resolved?.path) {
					return resolved.path;
				}
				return undefined;
			}

			case "https": {
				// HTTPS URL 总是先下载到 vault 再加载
				const dir = this.getDownloadDir() || this.getPrimaryDir();
				const filename = `script-${Date.now()}.js`;
				const relPath = `${dir}/${filename}`;
				const dlPath = await this.downloadToVault(
					location.url,
					relPath,
				);
				if (dlPath) {
					return dlPath;
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
	 * 下载清单中所有文件到 `<pluginDir>/pre-process-scripts/<cid>/` 目录。
	 * 返回基础目录路径，或 undefined 表示失败。
	 */
	private async materializeManifest(
		manifest: PresetManifest,
		location: ScriptLocation,
	): Promise<string | undefined> {
		// 使用清单自身的 CID 作为目录名（如果可用）
		const manifestCID =
			("cid" in location
				? (location as { cid: string }).cid
				: undefined) ?? `manifest-${Date.now()}`;
		const baseDir = `${this.getPluginDir()}/pre-process-scripts/${manifestCID}`;

		const entry = manifest.entry;
		const files = manifest.files;

		for (const [filename, fileSource] of Object.entries(files)) {
			const targetPath = `${baseDir}/${filename}`;

			// 检查文件是否已存在且 CID 匹配
			const exists = await this.exists(targetPath);
			if (exists) {
				continue;
			}

			// 尝试从 sources 下载
			let downloaded = false;
			if (fileSource.sources) {
				for (const sourceURL of fileSource.sources) {
					const dlPath = await this.downloadToVault(
						sourceURL,
						targetPath,
					);
					if (dlPath) {
						// 验证 CID
						const content = await this.readFile(dlPath);
						if (content) {
							const encoder = new TextEncoder();
							const data = encoder.encode(content).buffer;
							const actualCID = await this.computeCID(data);
							if (actualCID === fileSource.cid) {
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
		const entryExists = await this.exists(entryPath);
		if (!entryExists) {
			console.warn(
				`[preprocess] Manifest entry file not found: ${entryPath}`,
			);
			return undefined;
		}

		return baseDir;
	}
}

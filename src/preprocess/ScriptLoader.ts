import type {
	ScriptLoader,
	ScriptLocation,
	PreProcessScriptModule,
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
		/** 获取下载目录 */
		private getDownloadDir: () => string,
		/** 获取主存储目录 */
		private getPrimaryDir: () => string,
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
			const servableURL = await this.resolveToServableURL(location);
			if (!servableURL) return undefined;

			// 使用 getResourcePath 返回的 URL 作为 import 源
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

	private async resolveToServableURL(
		location: ScriptLocation,
	): Promise<string | undefined> {
		switch (location.type) {
			case "vault-relative":
				return this.getResourcePath(location.path);

			case "internal.ipfs-locked": {
				// 先尝试 URLResolver 解析到本地路径
				const resolved = await this.resolveURL(location.sourceURL);
				if (resolved?.path) {
					return this.getResourcePath(resolved.path);
				}
				// 兜底：尝试直接查找 CAS 文件
				const dir = this.getPrimaryDir();
				const cidStr = location.cid;
				const prefix = cidStr.slice(0, 2);
				const suffix = cidStr.slice(2);
				const casPath = `${dir}/${prefix}/${suffix}`;
				const exists = await this.exists(casPath);
				if (exists) {
					return this.getResourcePath(casPath);
				}
				// 尝试从 sourceURL 下载
				const dlPath = await this.downloadToVault(
					location.sourceURL,
					`${this.getDownloadDir() || dir}/${cidStr}.js`,
				);
				if (dlPath) {
					return this.getResourcePath(dlPath);
				}
				return undefined;
			}

			case "ipfs": {
				const ipfsURL = `ipfs://${location.cid}`;
				const resolved = await this.resolveURL(ipfsURL);
				if (resolved?.path) {
					return this.getResourcePath(resolved.path);
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
					return this.getResourcePath(dlPath);
				}
				return undefined;
			}
		}
	}
}

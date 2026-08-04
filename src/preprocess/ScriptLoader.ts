import type {
	ScriptLoader,
	ScriptLocation,
	PreProcessScriptModule,
} from "./types";

/** 已知的 URL scheme 前缀 */
const KNOWN_SCHEMES = ["https:", "ipfs:", "internal.ipfs-locked:"];

/**
 * 解析脚本 URL 为 ScriptLocation。
 * 规则：如果第一个冒号分隔的段是已知 scheme 之一，则为 URL 形式；否则为 vault 相对路径。
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

	return parseVaultRelative(trimmed);
}

/**
 * 从 URL 末尾提取 fragment 参数并返回。
 * fragment 格式: `k=v&k2=v2`
 */
function splitFragment(url: string): {
	baseURL: string;
	params: Record<string, string>;
} {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) {
		return { baseURL: url, params: {} };
	}
	const fragment = url.slice(hashIndex + 1);
	const params: Record<string, string> = {};
	for (const part of fragment.split("&")) {
		const eqIndex = part.indexOf("=");
		if (eqIndex > 0) {
			params[decodeURIComponent(part.slice(0, eqIndex))] =
				decodeURIComponent(part.slice(eqIndex + 1));
		} else if (part) {
			params[decodeURIComponent(part)] = "";
		}
	}
	return { baseURL: url.slice(0, hashIndex), params };
}

function parseURLForm(
	rawURL: string,
	scheme: string,
): ScriptLocation | undefined {
	const { baseURL, params } = splitFragment(rawURL);

	switch (scheme) {
		case "https:":
			return { type: "https", url: baseURL, params };
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
	const { baseURL, params } = splitFragment(rawURL);
	if (!baseURL) return undefined;
	return { type: "vault-relative", path: baseURL, params };
}

/**
 * 获取脚本 URL 中的参数（不加载脚本）。
 */
export function getParams(scriptURL: string): Record<string, string> {
	if (!scriptURL) return {};
	const { params } = splitFragment(scriptURL);
	return params;
}

/**
 * ScriptLoader 实现：解析脚本位置、动态 import、缓存模块实例。
 *
 * 依赖注入友好：接收 resolveURL 函数将 ipfs:// 等 URL 解析为本地路径，
 * 接收 getResourcePath 将 vault 路径转换为可 serve 的 URL。
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
		/** 动态 import 函数 */
		private dynamicImport: (url: string) => Promise<unknown> = (url) =>
			import(/* @vite-ignore */ url),
	) {}

	/**
	 * 将 HTTPS URL 锁定为 internal.ipfs-locked 格式。
	 * 下载内容到下载目录，计算 CID，重写设置为 locked 格式。
	 */
	async lockHTTPSURL(
		url: string,
	): Promise<
		{ lockedURL: string; module: PreProcessScriptModule } | undefined
	> {
		try {
			const response = await fetch(url);
			if (!response.ok) return undefined;
			const arrayBuffer = await response.arrayBuffer();
			const { CID } = await import("multiformats/cid");
			const { sha256 } = await import("multiformats/hashes/sha2");
			const digest = await sha256.digest(new Uint8Array(arrayBuffer));
			const cid = CID.create(1, 0x55, digest);

			const dir = this.getDownloadDir() || this.getPrimaryDir();
			const filename = `${cid.toString()}.js`;
			const relPath = `${dir}/${filename}`;

			const alreadyExists = await this.exists(relPath);
			if (!alreadyExists) {
				// 写入文件
				await this.downloadToVault(url, relPath);
			}

			const lockedURL = `internal.ipfs-locked:${cid.toString()},${url}`;

			// 尝试加载模块
			const module = await this.loadScript(lockedURL);
			if (!module) return undefined;

			this.moduleCache.set(lockedURL, module);
			return { lockedURL, module };
		} catch {
			return undefined;
		}
	}

	getParams(scriptURL: string): Record<string, string> {
		return getParams(scriptURL);
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

	private async doLoadScript(
		scriptURL: string,
	): Promise<PreProcessScriptModule | undefined> {
		const location = parseScriptURL(scriptURL);
		if (!location) return undefined;

		try {
			const servableURL = await this.resolveToServableURL(location);
			if (!servableURL) return undefined;

			const mod = await this.dynamicImport(servableURL);
			return mod as PreProcessScriptModule;
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
				// vault 相对路径 → adapter.getResourcePath(relPath) → app:// URL
				return this.getResourcePath(location.path);

			case "internal.ipfs-locked": {
				// 使用 URLResolver 解析到本地路径
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
				// HTTPS 不直接 import(blobURL)，而是先下载到 vault 再 import
				// 注意：这里只用于加载，不进行锁定操作
				const dir = this.getDownloadDir() || this.getPrimaryDir();
				const filename = `script-${Date.now()}.js`;
				const relPath = `${dir}/${filename}`;
				const dlPath = await this.downloadToVault(location.url, relPath);
				if (dlPath) {
					return this.getResourcePath(dlPath);
				}
				return undefined;
			}
		}
	}
}
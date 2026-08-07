import { type App, requestUrl } from "obsidian";
import type { URLResolver } from "#src/URLResolver";
import type { CAS } from "#src/types/CAS";
import type { Settings } from "#src/settings";
import type { ScriptLoaderOptions } from "./ScriptLoader";
import computeCID from "#src/utils/computeCID";
import parseIPFSLockedURL from "#src/utils/parseIPFSLockedURL";
import { CID } from "multiformats/cid";

/** ScriptLoaderAdapter 构造选项 */
export interface ScriptLoaderAdapterOptions {
	app: App;
	cas: CAS;
	urlResolver: URLResolver;
	getSettings: () => Settings;
	/**
	 * 当 resolveURL 将 HTTP(S) URL 解析为 CID 后被调用，
	 * 调用方可更新设置为 locked URL 格式。
	 */
	onScriptURLResolved?: (
		originalURL: string,
		lockedURL: string,
		cid: string,
	) => void;
}

/**
 * 装配 ScriptLoaderImpl 所需的选项，桥接插件基础设施与 ScriptLoader。
 *
 * 职责：
 * - 提供 ScriptLoaderOptions 所需的所有回调
 * - resolveURL 优先委托 URLResolver 处理 ipfs/internal.ipfs-locked URL
 * - 对 HTTP(S) 和 vault-relative 路径直接下载并保存到 CAS
 * - HTTP(S) URL 解析后触发 onScriptURLResolved 回调，将脚本锁定为 internal.ipfs-locked 格式
 */
export default class ScriptLoaderAdapter {
	constructor(private options: ScriptLoaderAdapterOptions) {}

	/** 构造 ScriptLoaderOptions 供 ScriptLoaderImpl 使用 */
	createOptions(): ScriptLoaderOptions {
		return {
			getResourcePath: (path) =>
				this.options.app.vault.adapter.getResourcePath(path),
			copy: async (cidStr, dst) => {
				const cid = CID.parse(cidStr);
				const match = await this.options.cas.load(cid);
				if (!match) {
					throw new Error(
						`[copy] CID not found in CAS: ${cidStr}`,
					);
				}
				const content =
					await this.options.app.vault.adapter.readBinary(
						match.normalizedPath,
					);
				await this.options.app.vault.adapter.writeBinary(
					dst,
					content,
				);
			},
			readFile: (path) => this.options.app.vault.adapter.read(path),
			getPluginDir: () =>
				`${this.options.app.vault.configDir}/plugins/content-addressed-attachments`,
			resolveURL: (rawURL) => this.resolveURL(rawURL),
		};
	}

	private async resolveURL(
		rawURL: string,
	): Promise<{ cid: string; path: string } | undefined> {
		// 优先使用 URLResolver 处理 ipfs 和 internal.ipfs-locked URL
		const urlResolverResult =
			await this.options.urlResolver.resolveURL(rawURL);
		if (urlResolverResult?.path) {
			// 从 URL 中提取 CID
			const lockedURL = parseIPFSLockedURL(rawURL);
			let cidStr: string;
			if (lockedURL) {
				cidStr = lockedURL.cid.toString();
			} else {
				const url = new URL(rawURL);
				cidStr = url.host;
			}
			return { cid: cidStr, path: urlResolverResult.path };
		}

		// 处理 HTTP(S) URL 和 vault-relative 路径
		const settings = this.options.getSettings();
		const dir = settings.downloadDir || settings.primaryDir;
		const colonIndex = rawURL.indexOf(":");
		let arrayBuffer: ArrayBuffer;
		if (colonIndex < 0) {
			// 无 scheme → vault-relative 路径
			const content =
				await this.options.app.vault.adapter.readBinary(rawURL);
			arrayBuffer = content;
		} else {
			const response = await requestUrl({
				url: rawURL,
				throw: false,
			});
			if (response.status !== 200) return undefined;
			arrayBuffer = response.arrayBuffer;
		}
		const cid = await computeCID(arrayBuffer);
		const file = new File([arrayBuffer], "download");
		const { cid: cidObj } = await this.options.cas.save(dir, file);
		const relPath = this.options.cas.formatNormalizePath(dir, cidObj);

		// HTTP(S) URL 锁定通知：触发外部回调使调用方可更新设置
		if (rawURL.startsWith("https://") || rawURL.startsWith("http://")) {
			const lockedURL = `internal.ipfs-locked:${cid},${rawURL}`;
			this.options.onScriptURLResolved?.(rawURL, lockedURL, cid);
		}

		return { cid, path: relPath };
	}
}
import { type App } from "obsidian";
import type { URLResolver } from "#src/URLResolver";
import type { ScriptLoaderOptions } from "./ScriptLoader";
import type { CID } from "multiformats/cid";

/** createScriptLoaderOptions 工厂函数参数 */
export interface CreateScriptLoaderOptionsParams {
	app: App;
	urlResolver: URLResolver;
	/**
	 * 当 resolveURL 将 HTTP(S) URL 解析为 CID 后被调用，
	 * 调用方可更新设置为 locked URL 格式。
	 */
	onScriptURLResolved?: (originalURL: string, lockedURL: string) => void;
}

/**
 * 装配 ScriptLoader 所需的选项，桥接插件基础设施与 ScriptLoader。
 *
 * 职责：
 * - 提供 ScriptLoaderOptions 所需的所有回调
 * - resolveURL 完全委托 URLResolver 处理所有 URL 类型
 * - HTTP(S) URL 解析后触发 onScriptURLResolved 回调，将脚本锁定为 internal.ipfs-locked 格式
 */
export default function createScriptLoaderOptions(
	options: CreateScriptLoaderOptionsParams,
): ScriptLoaderOptions {
	return {
		adapter: options.app.vault.adapter,
		pluginDir: `${options.app.vault.configDir}/plugins/content-addressed-attachments`,
		resolveURL: (rawURL) => resolveURL(options, rawURL),
	};
}

async function resolveURL(
	options: CreateScriptLoaderOptionsParams,
	rawURL: string,
): Promise<{ cid: CID; path: string } | undefined> {
	const result = await options.urlResolver.resolveURL(rawURL);
	if (!result?.path) return undefined;

	// HTTP(S) URL 锁定通知：触发外部回调使调用方可更新设置
	if (rawURL.startsWith("https://") || rawURL.startsWith("http://")) {
		const cidStr = result.cid.toString();
		const lockedURL = `internal.ipfs-locked:${cidStr},${rawURL}`;
		options.onScriptURLResolved?.(rawURL, lockedURL);
	}

	return { cid: result.cid, path: result.path };
}

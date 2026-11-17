/* eslint-disable import/no-nodejs-modules -- 需要 node:url 生成进程外可用的 file: URL */
import { pathToFileURL } from "node:url";
import type { CliHandler } from "obsidian";
import type { ResolveURLResult } from "#src/URLResolver";

/** CLI 仅接受这两种前缀，其余（http(s)、vault 相对路径等）在进入解析前拒绝 */
const SUPPORTED_PREFIXES = ["ipfs://", "internal.ipfs-locked:"] as const;

export function isSupportedCLIURL(rawURL: string): boolean {
	return SUPPORTED_PREFIXES.some((prefix) => rawURL.startsWith(prefix));
}

export interface CLIResolveResult {
	url: string;
	cid: string;
	/** 仅当 url 为 file: 时出现，指向可直接读取的明文文件 */
	path?: string;
}

export interface CLIResolveDeps {
	resolveURL: (rawURL: string) => Promise<ResolveURLResult | undefined>;
	getFullPath: (vaultRelativePath: string) => string;
	getMaxBlobSize: () => number;
}

/** 分块转 base64，避免大文件一次性展开二进制字符串撑爆调用栈 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * 复用 URLResolver 的解析与解密结果，转成 CLI 进程外可用的输出。
 * 应用内的 blob:/getResourcePath() 只能在当前 Obsidian 进程使用，
 * 因此按大小改写成内嵌字节的 data: URL 或指向明文文件的 file: URL。
 */
export async function resolveCLIURL(
	deps: CLIResolveDeps,
	rawURL: string,
): Promise<CLIResolveResult> {
	if (!isSupportedCLIURL(rawURL)) {
		throw new Error(
			`Unsupported URL for CLI: ${rawURL}. Only ipfs:// and internal.ipfs-locked: URLs are supported.`,
		);
	}
	const resolved = await deps.resolveURL(rawURL);
	if (!resolved) {
		throw new Error(`Attachment not found for ${rawURL}`);
	}
	// resolveURL 成功时只返回 blob:/getResourcePath()，data: 仅用于错误占位图。
	// 占位图不是附件内容，不能当成解密结果输出（否则伪装成功且 CID 不符）
	if (resolved.url.startsWith("data:")) {
		throw new Error(
			`resolveURL returned an error placeholder for ${rawURL}`,
		);
	}

	// requestUrl 只支持 HTTP(S)，而这里的 url 是 blob:/app: 资源路径
	const response = await window.fetch(resolved.url);
	if (!response.ok) {
		throw new Error(
			`Failed to read resolved content for ${rawURL}: HTTP ${response.status}`,
		);
	}
	const bytes = await response.arrayBuffer();
	const mime =
		response.headers.get("content-type")?.split(";")[0]?.trim() ||
		"application/octet-stream";

	const result: CLIResolveResult = { url: "", cid: resolved.cid.toString() };
	if (bytes.byteLength <= deps.getMaxBlobSize()) {
		result.url = `data:${mime};base64,${arrayBufferToBase64(bytes)}`;
		return result;
	}

	// 大文件在 resolveURL 中已落盘为明文（解密缓存或 CAS 文件）；
	// 加密小文件的 path 指向密文，但那条路径走上面的 data: 分支，不会到这里
	const plaintextPath = resolved.path;
	if (!plaintextPath) {
		throw new Error(`Large attachment has no readable path: ${rawURL}`);
	}
	result.url = pathToFileURL(deps.getFullPath(plaintextPath)).href;
	result.path = plaintextPath;
	return result;
}

/**
 * CLI handler 的返回值即 stdout：成功是单一 JSON，失败也包装成 JSON，
 * 让调用方可以统一 JSON.parse 后凭 error 字段判定，且绝不会输出空内容。
 */
export function createCLIResolveHandler(deps: CLIResolveDeps): CliHandler {
	return async (params) => {
		try {
			const url = params.url;
			if (typeof url !== "string" || !url) {
				throw new Error("Missing required flag: url");
			}
			return JSON.stringify(await resolveCLIURL(deps, url));
		} catch (err) {
			return JSON.stringify({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

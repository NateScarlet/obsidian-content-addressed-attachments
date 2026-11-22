import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import openRemoteByteSource from "#src/openRemoteByteSource";
import { applyHeaderRules } from "#src/utils/applyHeaderRules";
import type { HeaderRule } from "#src/URLResolver";
import type { SecretReader } from "#src/utils/renderHeaderValue";

/**
 * 「远程来源获取」seam：把 URL 下载进 CAS，并产出规范化路径与锁定链接。
 *
 * 通道选择（fetch 流式 / HEAD / Range / 受上限约束的整包）完全委托
 * {@link openRemoteByteSource}，本 module 只负责请求头装配、落盘、CID 校验
 * 与锁定链接构造。URLResolver 与 LockManager 共用这一处，避免下载能力分叉。
 */
export interface SaveRemoteOptions {
	url: string;
	/** 当前设置的 header 规则；在 seam 内应用，调用方不必重复装配 */
	headerRules: HeaderRule[];
	readSecret: SecretReader;
	/**
	 * 全局规则之后追加的请求头（网关专属头、Accept 默认值）。
	 * 调用方可在回调里检查已存在的头，实现「全局规则 + 网关覆盖 + 缺省 Accept」。
	 */
	decorateHeaders?: (headers: Headers) => Promise<void> | void;
	/** 调用方注入的落盘目录口径（下载目录 → 主目录已由调用方裁决） */
	dir: string;
	/** 整包下载上限；<= 0 表示永不整包 */
	maxWholeBodyBytes: number;
	signal?: AbortSignal;
	/** 落盘文件名 */
	name: string;
	/** 响应未给出 content-type 时的回退类型 */
	fallbackType?: string;
	/** 给定后校验落盘 CID；不符时回收本次新建的副本并返回 undefined */
	expectedCID?: CID;
}

export interface SaveRemoteResult {
	cid: CID;
	/** CAS 内的规范化路径 */
	path: string;
	/** internal.ipfs-locked:<cid>,<source URL> */
	lockedURL: string;
}

/** 远程来源没有产生可保存的内容（非 200 响应）。404 是否算合法缺失由调用方决定 */
export class RemoteSourceUnavailableError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
	) {
		super(`HTTP ${status} while resolving ${url}`);
		this.name = "RemoteSourceUnavailableError";
	}
}

export default async function saveRemoteToCAS(
	cas: Pick<CAS, "save" | "trash" | "formatNormalizePath">,
	options: SaveRemoteOptions,
): Promise<SaveRemoteResult | undefined> {
	const headers = new Headers();
	await applyHeaderRules(
		options.url,
		headers,
		options.headerRules,
		options.readSecret,
	);
	await options.decorateHeaders?.(headers);

	const opened = await openRemoteByteSource({
		url: options.url,
		headers,
		signal: options.signal,
		maxWholeBodyBytes: options.maxWholeBodyBytes,
		name: options.name,
		fallbackType: options.fallbackType,
	});
	if (opened.status !== 200 || !opened.source) {
		throw new RemoteSourceUnavailableError(opened.status, options.url);
	}

	const { cid, didCreate } = await cas.save(options.dir, opened.source);
	if (options.expectedCID && !cid.equals(options.expectedCID)) {
		// 内容已完整落盘但与期望 CID 不符：仅回收本次新建的副本，
		// 已有的正确副本不能动。与改造前 URLResolver 的行为一致。
		if (didCreate) {
			await cas.trash(cid);
		}
		return undefined;
	}

	const path = cas.formatNormalizePath(options.dir, cid);
	return {
		cid,
		path,
		lockedURL: `internal.ipfs-locked:${cid.toString()},${options.url}`,
	};
}

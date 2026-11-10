import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { ByteSource } from "#src/types/CAS";
import { headersToRecord } from "#src/utils/applyHeaderRules";
import isAbortError from "#src/utils/isAbortError";
import readStreamChunks from "#src/utils/readStreamChunks";
import {
	DownloadIntegrityError,
	WholeBodyTooLargeError,
} from "#src/ResolveURLError";

/**
 * HEAD 能力查询的超时。`requestUrl` 不可取消，超时只表示「不再等待这个来源」，
 * 迟到的响应会被丢弃；不能让挂住的 HEAD 拖住整体解析。
 */
export const HEAD_TIMEOUT_MS = 5_000;

/** Range 分块大小：单块内存占用与请求次数的折中 */
export const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

export interface RemoteByteSourceOptions {
	url: string;
	headers: Headers;
	signal?: AbortSignal;
	/** 允许整包下载的最大字节数；<= 0 表示永不允许整包 */
	maxWholeBodyBytes: number;
	name: string;
	/** 响应未给出可用的 content-type 时使用的类型 */
	fallbackType?: string;
}

/** 远程来源已打开：status 为实际数据响应的状态码，source 仅在 200 时给出 */
export interface OpenedRemoteSource {
	status: number;
	source?: ByteSource;
}

/**
 * 打开一个远程字节来源：按来源能力选择下载通道，任何通道都不把整个对象
 * 一次性读进内存（整包下载仅在没有其它通道且未超过上限时作为最后手段）。
 *
 * 分支顺序：
 * 1. `fetch` 的响应 body 可读（源允许 CORS）→ 直接流式读取；
 * 2. 否则用一次带超时的 HEAD 查询 `accept-ranges` 与 `content-length`；
 * 3. 支持 Range → 按块拉取，块边界与总长逐块校验；
 * 4. 不支持 Range → 未超过上限时整包下载，超过则拒绝（不发出该请求）。
 */
export default async function openRemoteByteSource(
	options: RemoteByteSourceOptions,
): Promise<OpenedRemoteSource> {
	throwIfAborted(options.signal);

	const streamed = await tryStreamWithFetch(options);
	if (streamed) return streamed;

	const head = await queryCapabilities(options);
	const contentLength = head?.contentLength;
	// 空对象没有缓冲风险：不发 Range 请求（会得到 416），也不受整包上限约束
	if (head?.acceptRanges && contentLength !== 0) {
		return {
			status: 200,
			source: createRangeByteSource(options, head.contentType),
		};
	}
	if (contentLength === 0) {
		return downloadWholeBody(options);
	}

	// ≤0 表示永不允许整包：总长未知时同样不能冒整包缓冲的风险
	if (
		options.maxWholeBodyBytes <= 0 ||
		(contentLength != null && contentLength > options.maxWholeBodyBytes)
	) {
		throw new WholeBodyTooLargeError(
			options.url,
			contentLength,
			options.maxWholeBodyBytes,
		);
	}

	return downloadWholeBody(options);
}

/** 与 {@link RemoteByteSourceOptions.signal} 对齐的中止检查 */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}
}

/** 响应头是大小写不敏感的普通对象，这里做统一查找 */
function headerValue(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/** 选择字节来源的类型：忽略无信息量的通用类型，回落到调用方给的类型 */
function pickType(
	contentType: string | undefined,
	fallback: string | undefined,
): string | undefined {
	if (contentType && contentType !== "application/octet-stream") {
		return contentType;
	}
	return fallback;
}

/** 第 1 支：fetch 流式读取。返回 undefined 表示该通道不可用（被 CORS 拦截或响应不可读） */
async function tryStreamWithFetch(
	options: RemoteByteSourceOptions,
): Promise<OpenedRemoteSource | undefined> {
	let response: Response;
	try {
		// eslint-disable-next-line no-restricted-globals -- 流式下载只能走 fetch：requestUrl 会把整包收进内存
		response = await fetch(options.url, {
			headers: options.headers,
			signal: options.signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		// CORS 拦截或网络不可达：交给 requestUrl 分支再判断来源能力
		return undefined;
	}

	if (response.status !== 200) {
		// 只需要状态码，内容直接丢弃，不占用连接
		void response.body?.cancel();
		return { status: response.status };
	}

	const body = response.body;
	if (!body) {
		return undefined;
	}
	const reader = body.getReader();
	return {
		status: 200,
		source: {
			name: options.name,
			type: pickType(
				response.headers.get("content-type") ?? undefined,
				options.fallbackType,
			),
			open: () => readStreamChunks(reader, options.signal),
		},
	};
}

interface HeadCapabilities {
	acceptRanges: boolean;
	contentLength?: number;
	contentType?: string;
}

/**
 * 第 2 支：用 HEAD 查询来源能力。
 * 返回 undefined 表示 HEAD 失败（非 200 或网络错误），调用方按「不支持 Range」处理。
 */
async function queryCapabilities(
	options: RemoteByteSourceOptions,
): Promise<HeadCapabilities | undefined> {
	const timeoutMarker = Symbol("head-timeout");
	let timer: number | undefined;
	const timeout = new Promise<typeof timeoutMarker>((resolve) => {
		timer = window.setTimeout(
			() => resolve(timeoutMarker),
			HEAD_TIMEOUT_MS,
		);
	});
	const head = requestUrl({
		url: options.url,
		method: "HEAD",
		headers: headersToRecord(options.headers),
		throw: false,
	}).catch(() => undefined);

	let response: RequestUrlResponse | undefined | typeof timeoutMarker;
	try {
		response = await Promise.race([head, timeout]);
	} finally {
		window.clearTimeout(timer);
	}

	throwIfAborted(options.signal);
	if (response === timeoutMarker) {
		throw new Error(
			`HEAD capability query timed out after ${HEAD_TIMEOUT_MS}ms: ${options.url}`,
		);
	}
	if (!response || response.status !== 200) {
		return undefined;
	}
	const acceptRanges = /bytes/i.test(
		headerValue(response.headers, "accept-ranges") ?? "",
	);
	const rawLength = headerValue(response.headers, "content-length");
	const contentLength = rawLength == null ? undefined : Number(rawLength);
	return {
		acceptRanges,
		contentLength:
			contentLength != null && Number.isFinite(contentLength)
				? contentLength
				: undefined,
		contentType: headerValue(response.headers, "content-type"),
	};
}

/** 第 3 支：按 Range 逐块拉取 */
function createRangeByteSource(
	options: RemoteByteSourceOptions,
	contentType: string | undefined,
): ByteSource {
	return {
		name: options.name,
		type: pickType(contentType, options.fallbackType),
		open: () => readRanges(options),
	};
}

/**
 * 按块请求数据。总长从第一块的 `Content-Range` 得到，不依赖 HEAD 的
 * `content-length`；每块都校验起止边界、总长与实际字节数。
 *
 * 取消语义：`requestUrl` 不可取消，中止只能表现为「当前块到达后不再请求
 * 下一块」，已在传输中的块无法撤回。
 */
async function* readRanges(
	options: RemoteByteSourceOptions,
): AsyncIterable<Uint8Array> {
	let offset = 0;
	let total: number | undefined;
	while (total === undefined || offset < total) {
		throwIfAborted(options.signal);
		const requestedEnd =
			total === undefined
				? offset + RANGE_CHUNK_BYTES - 1
				: Math.min(offset + RANGE_CHUNK_BYTES - 1, total - 1);
		const headers = headersToRecord(options.headers);
		headers["Range"] = `bytes=${offset}-${requestedEnd}`;
		const response = await requestUrl({
			url: options.url,
			headers,
			throw: false,
		});

		if (response.status !== 206) {
			if (response.status === 200) {
				// 服务器忽略了 Range：整包 body 已被 requestUrl 收进内存，无法再按块读取。
				// 属于该来源的能力问题，换一个支持 Range 的来源仍可能成功
				throw new Error(
					`Server ignored Range request at byte ${offset} for ${options.url}`,
				);
			}
			throw new Error(
				`HTTP ${response.status} while downloading range ${offset}-${requestedEnd} of ${options.url}`,
			);
		}

		const range = parseContentRange(
			headerValue(response.headers, "content-range"),
		);
		if (!range?.total) {
			throw new Error(
				`Missing or unparsable Content-Range for ${options.url}: ${
					headerValue(response.headers, "content-range") ?? "<none>"
				}`,
			);
		}
		if (total !== undefined && range.total !== total) {
			throw new DownloadIntegrityError(
				options.url,
				`total size changed from ${total} to ${range.total}`,
			);
		}

		const expectedEnd = Math.min(requestedEnd, range.total - 1);
		if (range.start !== offset || range.end !== expectedEnd) {
			throw new DownloadIntegrityError(
				options.url,
				`expected bytes ${offset}-${expectedEnd}, got ${range.start}-${range.end}`,
			);
		}

		const bytes = new Uint8Array(response.arrayBuffer);
		if (bytes.byteLength !== expectedEnd - offset + 1) {
			throw new DownloadIntegrityError(
				options.url,
				`expected ${expectedEnd - offset + 1} bytes for ${offset}-${expectedEnd}, got ${bytes.byteLength}`,
			);
		}

		total = range.total;
		yield bytes;
		offset = expectedEnd + 1;
	}
}

interface ContentRange {
	start: number;
	end: number;
	total: number;
}

/** 解析 `bytes 0-65535/126207190`；缺总长（`*`）或格式不符时返回 undefined */
function parseContentRange(
	value: string | undefined,
): ContentRange | undefined {
	const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
	if (!match) return undefined;
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
	};
}

/** 第 4 支：整包下载（仅在来源不支持前三种通道且未超过上限时使用） */
async function downloadWholeBody(
	options: RemoteByteSourceOptions,
): Promise<OpenedRemoteSource> {
	const response = await requestUrl({
		url: options.url,
		headers: headersToRecord(options.headers),
		throw: false,
	});
	if (response.status !== 200) {
		return { status: response.status };
	}
	const bytes = new Uint8Array(response.arrayBuffer);
	return {
		status: 200,
		source: {
			name: options.name,
			type: pickType(
				headerValue(response.headers, "content-type"),
				options.fallbackType,
			),
			size: bytes.byteLength,
			open: () => singleChunkIterable(bytes),
		},
	};
}

/** 已有一份完整缓冲区块时只需按异步迭代器产出一次，不复制内容 */
function singleChunkIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]: () => {
			let sent = false;
			return {
				next: () => {
					if (sent) {
						return Promise.resolve({
							done: true as const,
							value: undefined,
						});
					}
					sent = true;
					return Promise.resolve({
						done: false as const,
						value: bytes,
					});
				},
			};
		},
	};
}

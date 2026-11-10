import type { LocalizedText } from "./utils/localizedText";

/**
 * resolveURL 可预期失败的基类。
 *
 * 错误自身携带展示文案（中英各一份字段），展示层按界面语言直接读取，
 * 不解析 message、不维护映射表。新增失败源 = 新增错误类型，展示层无需改动。
 * 合法缺失（404 / CID 不匹配）不属于失败，仍由 resolveURL 返回 undefined 表达。
 */
export default abstract class ResolveURLError extends Error {
	/** 失败图等展示层使用的双语文案 */
	abstract readonly display: LocalizedText;
}

/** 全部远程来源均失败（来源不可达、请求异常等） */
export class AllSourcesFailedError extends ResolveURLError {
	readonly display: LocalizedText = {
		en: "Failed to load: all sources unavailable",
		zh: "加载失败：所有来源均不可用",
	};

	constructor(
		/** 参与本次解析的来源数量 */
		readonly sourceCount: number,
		/** 首个底层失败原因 */
		readonly reason: unknown,
	) {
		super(
			`All ${sourceCount} source(s) failed to resolve: ${
				reason instanceof Error ? reason.message : String(reason)
			}`,
		);
		this.name = "AllSourcesFailedError";
	}
}

/** 内容标识（CID 或承载它的链接）非法，无法定位内容 */
export class InvalidContentIDError extends ResolveURLError {
	readonly display: LocalizedText = {
		en: "Failed to load: invalid content ID",
		zh: "加载失败：内容标识无效",
	};

	constructor(
		/** 原始内容标识 */
		readonly identifier: string,
		readonly reason?: unknown,
	) {
		super(`Invalid content ID: ${identifier}`);
		this.name = "InvalidContentIDError";
	}
}

/** 加密文件解密失败（密钥缺失、数据损坏等） */
export class DecryptionFailedError extends ResolveURLError {
	readonly display: LocalizedText = {
		en: "Failed to decrypt file",
		zh: "文件解密失败",
	};

	constructor(
		/** 解密失败的加密文件路径 */
		readonly filePath: string,
		readonly reason: unknown,
	) {
		super(`Failed to decrypt file: ${filePath}`);
		this.name = "DecryptionFailedError";
	}
}

/**
 * 来源既不支持 CORS 流式读取、也不支持 Range，且整包大小超过内存下载上限：
 * 不发出会带回整包 body 的请求。换源仍可能成功（其它来源可能支持 Range），
 * 但全部来源都失败时应把这条具体原因展示给用户。
 */
export class WholeBodyTooLargeError extends ResolveURLError {
	readonly display: LocalizedText = {
		en: "Failed to load: file too large for this source",
		zh: "加载失败：文件超出该来源的下载上限",
	};

	constructor(
		readonly url: string,
		/** 总长已知时给出；HEAD 失败或未带 content-length 时为 undefined */
		readonly sizeBytes: number | undefined,
		readonly limitBytes: number,
	) {
		super(
			`Whole-body download of ${url} refused: size ${
				sizeBytes == null ? "unknown" : `${sizeBytes} bytes`
			}, limit ${limitBytes}`,
		);
		this.name = "WholeBodyTooLargeError";
	}
}

/**
 * 分块下载的分块边界、总长与实际字节数互相矛盾。
 * 属于内容级失败：同一 CID 的内容在所有来源一致，换源没有意义。
 */
export class DownloadIntegrityError extends ResolveURLError {
	readonly display: LocalizedText = {
		en: "Failed to load: incomplete download",
		zh: "加载失败：下载内容不完整",
	};

	constructor(
		readonly url: string,
		readonly detail: string,
	) {
		super(`Download integrity check failed for ${url}: ${detail}`);
		this.name = "DownloadIntegrityError";
	}
}

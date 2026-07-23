import type { KeyManager } from "./KeyManager";
import { CryptoService } from "./CryptoService";
import { ENCRYPTED_FORMAT, type EncryptedFileHeader } from "./types";
import type { EncryptPathRule } from "#src/settings";
import ignore from "ignore";

/** 支持的统一二进制输入载体 */
export type BinaryInput = Blob | File | ArrayBuffer | Uint8Array;

/** 解密富结果接口，提供各种输出载体的转换能力 */
export interface DecryptedResult {
	/** 解密后的原始字节 */
	data: ArrayBuffer;
	/** 还原后的 MIME 类型 */
	mimeType: string;
	/** 解析出的原始 CENC Header */
	header: EncryptedFileHeader;
	/** 转化为 Blob */
	toBlob(): Blob;
	/** 一键转化为 UI 预览用的 Blob URL */
	toBlobURL(): string;
}

/**
 * 辅助函数：将任意 BinaryInput 转换为 ArrayBuffer
 */
async function toArrayBuffer(input: BinaryInput): Promise<ArrayBuffer> {
	if (input instanceof ArrayBuffer) {
		return input;
	}
	if (ArrayBuffer.isView(input)) {
		return input.buffer.slice(
			input.byteOffset,
			input.byteOffset + input.byteLength,
		) as ArrayBuffer;
	}
	if (input instanceof Blob) {
		return input.arrayBuffer();
	}
	throw new Error("Unsupported binary input format");
}

/**
 * # EncryptionService 架构设计说明
 *
 * ## 1. 构造与使用分离 (Separation of Construction & Usage)
 * - **构造阶段 (Construction)**: 通过构造函数显式注入 `KeyManager`、`CryptoService` 和路径规则获取器，无隐式全局依赖，方便单元测试与环境解耦。
 * - **使用阶段 (Usage)**: 面向高层业务场景暴露极简、高杠杆（Deep Module）的方法。调用方只需表达“加密数据”或“解密数据”，完全无需感知 Key 的查找过程、路径规则匹配、CENC Header 打包及底层 AES-GCM 算术。
 *
 * ## 2. 统一二进制输入与输出抽象 (Unified Binary Abstraction)
 * - **输入统一 (`BinaryInput`)**: 接受 `File` / `Blob` / `ArrayBuffer` / `Uint8Array` 任意数据载体，调用方无需手动做数据转换。
 * - **输出统一 (`DecryptedResult`)**: 解密后返回具备自描述能力的富结果，提供 `.toBlob()` 和 `.toBlobURL()` 等便利方法，屏蔽 Blob / BlobURL 等转换细节。
 */
export class EncryptionService {
	constructor(
		readonly keyManager: KeyManager,
		private readonly getRules: () => EncryptPathRule[] = () => [],
		private readonly cryptoService: CryptoService = new CryptoService(),
	) {}

	/** 当前密钥库是否可用 */
	get isAvailable(): boolean {
		return this.keyManager.isAvailable;
	}

	/** 根据笔记路径和规则解析应使用的 keyFingerprint */
	async resolveKeyForNotePath(notePath: string): Promise<string | undefined> {
		if (!this.isAvailable) return undefined;

		const rules = this.getRules();
		const rule = rules.find(
			(r) => r.pattern && ignore().add(r.pattern).ignores(notePath),
		);
		if (!rule) return (await this.keyManager.getPrimaryKey())?.fingerprint;

		if (rule.keyFingerprint) {
			const key = await this.keyManager.getKeyForEncrypt(
				rule.keyFingerprint,
			);
			if (key) return rule.keyFingerprint;
		}

		return (await this.keyManager.getPrimaryKey())?.fingerprint;
	}

	/**
	 * 加密数据。
	 * 接收任意二进制输入（File / Blob / ArrayBuffer / Uint8Array），
	 * 自动完成路径规则匹配、密钥检索、防重复加密校验及 Web Crypto 打包，
	 * 返回适配 CAS.save 规范的 File 对象及使用的密钥指纹。
	 */
	async encrypt(
		input: BinaryInput,
		options?: {
			filename?: string;
			notePath?: string;
			keyFingerprint?: string;
		},
	): Promise<{ encryptedFile: File; fingerprint: string } | undefined> {
		const fingerprint =
			(options?.keyFingerprint
				? await this.keyManager
						.getKeyForEncrypt(options.keyFingerprint)
						.then((k) => (k ? options.keyFingerprint : undefined))
				: undefined) ??
			(options?.notePath
				? await this.resolveKeyForNotePath(options.notePath)
				: undefined) ??
			(await this.keyManager.getPrimaryKey())?.fingerprint;

		if (!fingerprint) return undefined;

		const key = await this.keyManager.getKeyForEncrypt(fingerprint);
		if (!key) throw new Error(`Encryption key ${fingerprint} not found`);

		const buffer = await toArrayBuffer(input);
		const filename =
			options?.filename ??
			(input instanceof File ? input.name : "attachment");
		const mimeType =
			input instanceof Blob && input.type
				? input.type
				: "application/octet-stream";

		// 检查文件是否已经被加密
		if (this.cryptoService.isEncryptedData(buffer)) {
			try {
				const header = this.cryptoService.parseHeader(buffer);
				if (header.keyFingerprint === fingerprint) {
					const encryptedFile =
						mimeType === ENCRYPTED_FORMAT && input instanceof File
							? input
							: new File([buffer], filename, {
									type: ENCRYPTED_FORMAT,
								});
					return { encryptedFile, fingerprint };
				} else {
					throw new Error(
						`File "${filename}" is already encrypted with key "${header.keyFingerprint}". Please decrypt it first before re-encrypting with key "${fingerprint}".`,
					);
				}
			} catch (err) {
				if (
					err instanceof Error &&
					err.message.includes("already encrypted")
				) {
					throw err;
				}
			}
		}

		const data = await this.cryptoService.encrypt(
			key,
			fingerprint,
			buffer,
			mimeType,
		);

		const encryptedFile = new File([new Blob([data])], filename, {
			type: ENCRYPTED_FORMAT,
		});

		return { encryptedFile, fingerprint };
	}

	/**
	 * 解密数据。
	 * 接收任意二进制输入，自动解析 CENC Header 里的 keyFingerprint 从 KeyManager 查找密钥并完成解密，
	 * 返回包含 .toBlob() 和 .toBlobURL() 便利方法的 DecryptedResult。
	 */
	async decrypt(input: BinaryInput): Promise<DecryptedResult | undefined> {
		const buffer = await toArrayBuffer(input);

		if (!this.cryptoService.isEncryptedData(buffer)) return undefined;

		const { plaintext, header } = await this.cryptoService.decrypt(
			(fp) => this.keyManager.getKey(fp),
			buffer,
		);

		const mimeType = header.originalFormat || "application/octet-stream";

		return {
			data: plaintext,
			mimeType,
			header,
			toBlob() {
				return new Blob([plaintext], { type: mimeType });
			},
			toBlobURL() {
				return URL.createObjectURL(
					new Blob([plaintext], { type: mimeType }),
				);
			},
		};
	}

	/** 判断数据是否为加密格式 */
	isEncryptedData(input: BinaryInput): Promise<boolean> | boolean {
		if (input instanceof ArrayBuffer) {
			return this.cryptoService.isEncryptedData(input);
		}
		if (ArrayBuffer.isView(input)) {
			return this.cryptoService.isEncryptedData(
				input.buffer.slice(
					input.byteOffset,
					input.byteOffset + input.byteLength,
				) as ArrayBuffer,
			);
		}
		return toArrayBuffer(input).then((buf) =>
			this.cryptoService.isEncryptedData(buf),
		);
	}

	static isEncryptedFormat(format: string): boolean {
		return format === ENCRYPTED_FORMAT;
	}
}

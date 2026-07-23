import type { KeyManager } from "./KeyManager";
import { CryptoService } from "./CryptoService";
import { ENCRYPTED_FORMAT, type EncryptedFileHeader } from "./types";

/** 支持的统一二进制输入载体 */
export type BinaryInput = Blob | File | ArrayBuffer | Uint8Array;

/** 解密富结果接口，提供各种输出载体的转换能力 */
export interface DecryptedResult {
	/** 解密/解包后的原始字节 */
	data: ArrayBuffer;
	/** 原始 MIME 类型 (例如 "image/png") */
	mimeType: string;
	/** 输入数据是否原本为加密状态 */
	wasEncrypted: boolean;
	/** 解析出的 Header 元数据（仅当原本为加密数据时存在） */
	header?: EncryptedFileHeader;
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
 * # EncryptionService 物理加解密服务
 *
 * 专注物理二进制数据的加解密算术与 CENC Header 解析，彻底不包含任何 Obsidian 笔记路径或规则的概念。
 *
 * - **`inspect(input)`**: Safe 元数据探针（只读解析 Header，明文安全返回 `undefined`）。
 * - **`ensureDecrypted(input)`**: 确保得到明文（密文解密，明文直接包装；具备幂等性）。
 * - **`ensureEncrypted(input, keyFingerprint?)`**: 物理层强力确保加密（使用指定 Key 或主 Key 加密；具备防二次加密幂等性）。
 */
export class EncryptionService {
	constructor(
		readonly keyManager: KeyManager,
		private readonly cryptoService: CryptoService = new CryptoService(),
	) {}

	/** 当前密钥库是否可用 */
	get isAvailable(): boolean {
		return this.keyManager.isAvailable;
	}

	/**
	 * Safe 的元数据探针。
	 * 尝试解析数据的加密 Header。如果为加密数据，返回 Header 元数据（含 `keyFingerprint`, `originalFormat` 等）；
	 * 如果为明文数据或非法格式，安全返回 `undefined`，绝不抛出错误。
	 */
	async inspect(
		input: BinaryInput,
	): Promise<EncryptedFileHeader | undefined> {
		try {
			const buffer = await toArrayBuffer(input);
			if (!this.cryptoService.isEncryptedData(buffer)) {
				return undefined;
			}
			return this.cryptoService.parseHeader(buffer);
		} catch {
			return undefined;
		}
	}

	/**
	 * 确保得到明文 (Ensure Plaintext)。
	 * - 若输入为密文：自动解密并返回 `DecryptedResult`（`wasEncrypted = true`）；
	 * - 若输入已为明文：直接包装为 `DecryptedResult`（`wasEncrypted = false`）。
	 */
	async ensureDecrypted(
		input: BinaryInput,
	): Promise<DecryptedResult | undefined> {
		const buffer = await toArrayBuffer(input);
		const header = await this.inspect(buffer);

		if (header) {
			// 加密密文 ➔ 解密
			const { plaintext } = await this.cryptoService.decrypt(
				(fp) => this.keyManager.getKey(fp),
				buffer,
			);
			const mimeType =
				header.originalFormat || "application/octet-stream";
			return {
				data: plaintext,
				mimeType,
				wasEncrypted: true,
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
		} else {
			// 明文 ➔ 原样包装
			const mimeType =
				input instanceof Blob &&
				input.type &&
				input.type !== ENCRYPTED_FORMAT
					? input.type
					: "application/octet-stream";
			return {
				data: buffer,
				mimeType,
				wasEncrypted: false,
				toBlob() {
					return new Blob([buffer], { type: mimeType });
				},
				toBlobURL() {
					return URL.createObjectURL(
						new Blob([buffer], { type: mimeType }),
					);
				},
			};
		}
	}

	/**
	 * 强力确保加密 (Ensure Ciphertext)。
	 * 无论如何输出必须为加密后的密文 `File`（具备防二次加密幂等性）。
	 * - 若输入为明文：使用指定指纹或主密钥加密；
	 * - 若输入已是相同指纹加密的密文：原样返回；
	 * - 若没有可用的加密密钥：抛出异常（绝不静默退回到明文）。
	 */
	async ensureEncrypted(
		input: BinaryInput,
		keyFingerprint?: string,
	): Promise<File> {
		const fingerprint =
			(keyFingerprint
				? await this.keyManager
						.getKeyForEncrypt(keyFingerprint)
						.then((k) => (k ? keyFingerprint : undefined))
				: undefined) ??
			(await this.keyManager.getPrimaryKey())?.fingerprint;

		if (!fingerprint) {
			throw new Error("No encryption key available for encryption");
		}

		const key = await this.keyManager.getKeyForEncrypt(fingerprint);
		if (!key) throw new Error(`Encryption key ${fingerprint} not found`);

		const buffer = await toArrayBuffer(input);
		const filename = input instanceof File ? input.name : "attachment";
		const mimeType =
			input instanceof Blob && input.type
				? input.type
				: "application/octet-stream";

		const existingHeader = await this.inspect(buffer);
		if (existingHeader) {
			if (existingHeader.keyFingerprint === fingerprint) {
				return mimeType === ENCRYPTED_FORMAT && input instanceof File
					? input
					: new File([buffer], filename, {
							type: ENCRYPTED_FORMAT,
						});
			} else {
				throw new Error(
					`File "${filename}" is already encrypted with key "${existingHeader.keyFingerprint}". Please decrypt it first before re-encrypting with key "${fingerprint}".`,
				);
			}
		}

		const data = await this.cryptoService.encrypt(
			key,
			fingerprint,
			buffer,
			mimeType,
		);

		return new File([new Blob([data])], filename, {
			type: ENCRYPTED_FORMAT,
		});
	}

	static isEncryptedFormat(format: string): boolean {
		return format === ENCRYPTED_FORMAT;
	}
}

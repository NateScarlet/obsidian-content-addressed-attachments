import type { KeyManager } from "./KeyManager";
import * as cryptoUtils from "./cryptoUtils";
import { ENCRYPTED_FORMAT, type EncryptedFileHeader } from "./types";
import { parseHeader } from "./fileHeader";
import { toArrayBufferFromBinary, type BinaryInput } from "#src/utils/toArrayBuffer";

/** 加密层信息 */
export type EncryptionLayer = { header: EncryptedFileHeader };

/** 解密富结果接口，提供各种输出载体的转换能力 */
export interface DecryptedResult {
	/** 解密/解包后的原始字节 */
	data: ArrayBuffer;
	/** 原始 MIME 类型 (例如 "image/png") */
	mimeType: string;
	/** 解密历经的加密层列表（由外到内，明文则为空数组 []） */
	layers: EncryptionLayer[];
	/** 转化为 Blob */
	toBlob(): Blob;
}

/**
 * # EncryptionService 物理加解密服务
 *
 * 专注物理二进制数据的加解密算术与 CENC Header 解析，不包含任何 Obsidian 笔记路径或规则的概念。
 *
 * - **`inspect(input)`**: Safe 元数据探针（只读解析 Header，明文安全返回 `undefined`）。
 * - **`ensureDecrypted(input)`**: 确保得到明文（持续解密直至得到纯明文；绝对返回 `DecryptedResult`，非 `undefined`）。
 * - **`ensureEncrypted(input, keyFingerprint?)`**: 物理层强力确保加密（使用指定 Key 或主 Key 加密；具备防二次加密幂等性）。
 */
export default class EncryptionService {
	constructor(readonly keyManager: KeyManager) {}

	/**
	 * Safe 的元数据探针。
	 * 尝试解析数据的加密 Header。如果为加密数据，返回 Header 元数据（含 `keyFingerprint`, `originalFormat` 等）；
	 * 如果为明文数据或非法格式，安全返回 `undefined`，绝不抛出错误。
	 */
	async inspect(
		input: BinaryInput,
	): Promise<EncryptedFileHeader | undefined> {
		const buffer = await toArrayBufferFromBinary(input);
		return parseHeader(buffer);
	}

	/**
	 * 确保得到明文 (Ensure Plaintext)。
	 * 自动处理嵌套/多重加密，持续解密直到得到完全纯净的明文数据。
	 * 绝对返回 `DecryptedResult`，绝不返回 `undefined`。
	 */
	async ensureDecrypted(input: BinaryInput): Promise<DecryptedResult> {
		let currentBuffer = await toArrayBufferFromBinary(input);
		const layers: EncryptionLayer[] = [];
		let mimeType =
			input instanceof Blob &&
			input.type &&
			input.type !== ENCRYPTED_FORMAT
				? input.type
				: "application/octet-stream";

		while (true) {
			const header = await this.inspect(currentBuffer);
			if (!header) break;

			layers.push({ header });
			const { plaintext } = await cryptoUtils.decrypt(
				(fp) => this.keyManager.getKey(fp),
				currentBuffer,
			);
			currentBuffer = plaintext;
			if (
				header.originalFormat &&
				header.originalFormat !== ENCRYPTED_FORMAT
			) {
				mimeType = header.originalFormat;
			}
		}

		return {
				data: currentBuffer,
				mimeType,
				layers,
				toBlob() {
					return new Blob([currentBuffer], { type: mimeType });
				},
			};
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
		let key: CryptoKey | undefined;
			let fingerprint: string | undefined;

			if (keyFingerprint) {
				key = await this.keyManager.getKeyForEncrypt(keyFingerprint);
				if (key) fingerprint = keyFingerprint;
			}

			if (!key) {
				const primary = await this.keyManager.getPrimaryKey();
				if (primary) {
					fingerprint = primary.fingerprint;
					key = await this.keyManager.getKeyForEncrypt(fingerprint);
				}
			}

			if (!key || !fingerprint) {
				throw new Error("No encryption key available for encryption");
			}

		const buffer = await toArrayBufferFromBinary(input);
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

		const data = await cryptoUtils.encrypt(
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

import type { KeyManager } from "./KeyManager";
import { CryptoService } from "./CryptoService";
import { ENCRYPTED_FORMAT, type DecryptedFile } from "./types";

export class EncryptionService {
	constructor(
		readonly keyManager: KeyManager,
		private readonly cryptoService: CryptoService = new CryptoService(),
	) {}

	get isAvailable(): boolean {
		return this.keyManager.isAvailable;
	}

	/** 加密文件内容，返回可直接用于 CAS.save 的 File 对象 */
	async encryptFile(
		keyFingerprint: string,
		file: File,
	): Promise<{ encryptedFile: File; fingerprint: string }> {
		const key = await this.keyManager.getKeyForEncrypt(keyFingerprint);
		if (!key) throw new Error(`Encryption key ${keyFingerprint} not found`);

		const buffer = await file.arrayBuffer();

		// 检查文件是否已经被加密
		if (this.cryptoService.isEncryptedData(buffer)) {
			try {
				const header = this.cryptoService.parseHeader(buffer);
				if (header.keyFingerprint === keyFingerprint) {
					// 已使用相同的密钥加密，直接原样返回
					const encryptedFile =
						file.type === ENCRYPTED_FORMAT
							? file
							: new File([file], file.name, {
									type: ENCRYPTED_FORMAT,
								});
					return { encryptedFile, fingerprint: keyFingerprint };
				} else {
					// 使用了不同的密钥加密，报错要求先解密
					throw new Error(
						`File "${file.name}" is already encrypted with key "${header.keyFingerprint}". Please decrypt it first before re-encrypting with key "${keyFingerprint}".`,
					);
				}
			} catch (err) {
				if (
					err instanceof Error &&
					err.message.includes("already encrypted")
				) {
					throw err;
				}
				// 非有效文件头则按普通明文继续加密
			}
		}

		const data = await this.cryptoService.encrypt(
			key,
			keyFingerprint,
			buffer,
			file.type,
		);

		const encryptedFile = new File([new Blob([data])], file.name, {
			type: ENCRYPTED_FORMAT,
		});

		return { encryptedFile, fingerprint: keyFingerprint };
	}

	/** 解密加密文件内容 */
	async decryptFile(
		encryptedData: ArrayBuffer,
	): Promise<DecryptedFile | undefined> {
		if (!this.cryptoService.isEncryptedData(encryptedData)) return;

		const { plaintext, header } = await this.cryptoService.decrypt(
			(fp) => this.keyManager.getKey(fp),
			encryptedData,
		);

		return {
			data: plaintext,
			mimeType: header.originalFormat || "application/octet-stream",
		};
	}

	/** 创建加密文件的 blob URL */
	async createBlobURL(
		encryptedData: ArrayBuffer,
	): Promise<string | undefined> {
		const decrypted = await this.decryptFile(encryptedData);
		if (!decrypted) return;
		const blob = new Blob([decrypted.data], { type: decrypted.mimeType });
		return URL.createObjectURL(blob);
	}

	/** 判断是否为加密格式标记 */
	static isEncryptedFormat(format: string): boolean {
		return format === ENCRYPTED_FORMAT;
	}
}

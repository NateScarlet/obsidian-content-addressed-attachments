import type { App } from "obsidian";
import { KeyManager } from "./KeyManager";
import {
	encrypt as cryptoEncrypt,
	decrypt as cryptoDecrypt,
	isEncryptedData,
	parseHeader,
} from "./CryptoService";
import {
	ENCRYPTED_FORMAT,
	type EncryptionKeyInfo,
	type DecryptedFile,
} from "./types";

const DEFAULT_MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20MB

export class EncryptionService {
	public readonly keyManager: KeyManager;

	constructor(private app: App) {
		this.keyManager = new KeyManager(app);
	}

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
		const { data, fingerprint } = await cryptoEncrypt(key, buffer, file.type);

		const encryptedFile = new File(
			[new Blob([data])],
			file.name,
			{ type: ENCRYPTED_FORMAT },
		);

		return { encryptedFile, fingerprint };
	}

	/** 解密加密文件内容 */
	async decryptFile(
		encryptedData: ArrayBuffer,
	): Promise<DecryptedFile | undefined> {
		if (!isEncryptedData(encryptedData)) return;

		const header = parseHeader(encryptedData);
		const key = await this.keyManager.getKey(header.keyFingerprint);
		if (!key) {
			throw new Error(
				`Decryption key ${header.keyFingerprint} not found. The key may have been deleted.`,
			);
		}

		const plaintext = await cryptoDecrypt(key, encryptedData);

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

	/** 获取最大 blob 大小阈值 */
	get maxBlobSize(): number {
		return DEFAULT_MAX_BLOB_SIZE;
	}

	/** 列出可用密钥 */
	async listKeys(): Promise<EncryptionKeyInfo[]> {
		return this.keyManager.listKeys();
	}
}

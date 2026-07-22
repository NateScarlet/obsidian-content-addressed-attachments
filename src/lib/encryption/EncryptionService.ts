import { KeyManager } from "./KeyManager";
import { CryptoService } from "./CryptoService";
import {
	ENCRYPTED_FORMAT,
	type EncryptionKeyInfo,
	type DecryptedFile,
} from "./types";

import type { Settings } from "#src/settings";
import ignore from "ignore";

export class EncryptionService {
	constructor(
		public readonly keyManager: KeyManager,
		private readonly getSettings: () => Pick<
			Settings,
			"encryptPathRules"
		> = () => ({
			encryptPathRules: [],
		}),
		public readonly cryptoService: CryptoService = new CryptoService(),
		public readonly maxBlobSize: number = 20 * 1024 * 1024,
	) {}

	get isAvailable(): boolean {
		return this.keyManager.isAvailable;
	}

	/** 根据笔记路径和规则决定使用哪个 key 加密 */
	async resolveKeyForNotePath(notePath: string): Promise<string | undefined> {
		const rules = this.getSettings().encryptPathRules;
		const rule = rules.find(
			(r) => r.pattern && ignore().add(r.pattern).ignores(notePath),
		);
		if (!rule) return undefined;
		return (
			rule.keyFingerprint ||
			(await this.keyManager.getPrimaryKey())?.fingerprint
		);
	}

	/** 加密文件内容，返回可直接用于 CAS.save 的 File 对象 */
	async encryptFile(
		keyFingerprint: string,
		file: File,
	): Promise<{ encryptedFile: File; fingerprint: string }> {
		const key = await this.keyManager.getKeyForEncrypt(keyFingerprint);
		if (!key) throw new Error(`Encryption key ${keyFingerprint} not found`);

		const buffer = await file.arrayBuffer();
		const { data, fingerprint } = await this.cryptoService.encrypt(
			key,
			buffer,
			file.type,
		);

		const encryptedFile = new File([new Blob([data])], file.name, {
			type: ENCRYPTED_FORMAT,
		});

		return { encryptedFile, fingerprint };
	}

	/** 解密加密文件内容 */
	async decryptFile(
		encryptedData: ArrayBuffer,
	): Promise<DecryptedFile | undefined> {
		if (!this.cryptoService.isEncryptedData(encryptedData)) return;

		const header = this.cryptoService.parseHeader(encryptedData);
		const key = await this.keyManager.getKey(header.keyFingerprint);
		if (!key) {
			throw new Error(
				`Decryption key ${header.keyFingerprint} not found. The key may have been deleted.`,
			);
		}

		const plaintext = await this.cryptoService.decrypt(key, encryptedData);

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

	/** 列出可用密钥 */
	async listKeys(): Promise<EncryptionKeyInfo[]> {
		return this.keyManager.listKeys();
	}
}

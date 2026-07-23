import { KeyManager } from "./KeyManager";
import { CryptoService } from "./CryptoService";
import {
	ENCRYPTED_FORMAT,
	type EncryptionKeyInfo,
	type DecryptedFile,
	type EncryptedFileHeader,
} from "./types";

import type { Settings } from "#src/settings";
import ignore from "ignore";

export class EncryptionService {
	constructor(
		private readonly keyManager: KeyManager,
		private readonly getSettings: () => Pick<
			Settings,
			"encryptPathRules" | "maxBlobSize"
		> = () => ({
			encryptPathRules: [],
			maxBlobSize: 20 * 1024 * 1024,
		}),
		private readonly cryptoService: CryptoService = new CryptoService(),
	) {}

	get maxBlobSize(): number {
		return this.getSettings().maxBlobSize;
	}

	get isAvailable(): boolean {
		return this.keyManager.isAvailable;
	}

	/** 根据笔记路径和规则决定使用哪个 key 加密 */
	async resolveKeyForNotePath(notePath: string): Promise<string | undefined> {
		if (!this.isAvailable) return undefined;

		const rules = this.getSettings().encryptPathRules;
		const rule = rules.find(
			(r) => r.pattern && ignore().add(r.pattern).ignores(notePath),
		);
		if (!rule) return undefined;

		if (rule.keyFingerprint) {
			const key = await this.keyManager.getKeyForEncrypt(
				rule.keyFingerprint,
			);
			if (key) return rule.keyFingerprint;
		}

		return (await this.keyManager.getPrimaryKey())?.fingerprint;
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

	/** 检查数据是否为加密文件格式 */
	isEncryptedData(data: ArrayBuffer): boolean {
		return this.cryptoService.isEncryptedData(data);
	}

	/** 从加密文件数据中解析头部信息 */
	parseHeader(encryptedData: ArrayBuffer): EncryptedFileHeader {
		return this.cryptoService.parseHeader(encryptedData);
	}

	/** 列出可用密钥 */
	async listKeys(): Promise<EncryptionKeyInfo[]> {
		return this.keyManager.listKeys();
	}

	/** 创建新密钥 */
	async createKey(name: string): Promise<EncryptionKeyInfo> {
		return this.keyManager.createKey(name);
	}

	/** 删除密钥（软删除） */
	async deleteKey(fingerprint: string): Promise<void> {
		return this.keyManager.deleteKey(fingerprint);
	}

	/** 恢复已软删除的密钥 */
	async restoreKey(fingerprint: string): Promise<void> {
		return this.keyManager.restoreKey(fingerprint);
	}

	/** 永久删除超过指定天数的已删除密钥 */
	async permanentlyDeleteKeys(olderThanDays: number): Promise<number> {
		return this.keyManager.permanentlyDeleteKeys(olderThanDays);
	}

	/** 列出已删除的密钥 */
	async listDeletedKeys(): Promise<EncryptionKeyInfo[]> {
		return this.keyManager.listDeletedKeys();
	}

	/** 导出单条密钥 */
	async exportKey(fingerprint: string): Promise<string | undefined> {
		return this.keyManager.exportKey(fingerprint);
	}

	/** 重命名密钥 */
	async renameKey(fingerprint: string, newName: string): Promise<void> {
		return this.keyManager.renameKey(fingerprint, newName);
	}

	/** 导出所有加密密钥 */
	async exportAllKeys(passphrase: string): Promise<string> {
		return this.keyManager.exportAllKeys(passphrase);
	}

	/** 导入密钥备份 */
	async importAllKeys(
		encryptedJson: string,
		passphrase: string,
	): Promise<number> {
		return this.keyManager.importAllKeys(encryptedJson, passphrase);
	}

	/** 设置主密钥 */
	async setPrimaryKey(fingerprint: string): Promise<void> {
		return this.keyManager.setPrimaryKey(fingerprint);
	}

	/** 获取主密钥 */
	async getPrimaryKey(): Promise<EncryptionKeyInfo | undefined> {
		return this.keyManager.getPrimaryKey();
	}

	/** 获取加密密钥（跳过已软删除的密钥） */
	async getKeyForEncrypt(
		fingerprint: string,
	): Promise<CryptoKey | undefined> {
		return this.keyManager.getKeyForEncrypt(fingerprint);
	}
}

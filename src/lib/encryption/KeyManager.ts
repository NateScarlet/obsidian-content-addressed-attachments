import {
	generateKey,
	exportKeyRaw,
	importKeyRawEncrypt,
	importKeyRaw,
	computeFingerprint,
} from "./CryptoService";
import {
	SECRET_STORAGE_KEY_PREFIX,
	SECRET_STORAGE_META_KEY,
	type EncryptionKeyInfo,
	type KeyStorage,
} from "./types";

function fingerprintToStorageKey(fingerprint: string): string {
	return `${SECRET_STORAGE_KEY_PREFIX}${fingerprint}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return buffer;
}

export class KeyManager {
	constructor(
		private storage: KeyStorage,
		private _isAvailable = true,
	) {}

	/** 检查 SecretStorage 是否可用 */
	get isAvailable(): boolean {
		return this._isAvailable;
	}

	/** 创建新密钥 */
	async createKey(name: string): Promise<EncryptionKeyInfo> {
		const key = await generateKey();
		const raw = await exportKeyRaw(key);
		const fingerprint = await computeFingerprint(raw);

		// 存储密钥材料到 SecretStorage
		await this.storage.setSecret(
			fingerprintToStorageKey(fingerprint),
			arrayBufferToBase64(raw.buffer as ArrayBuffer),
		);

		// 更新元数据
		await this.saveKeyMeta(fingerprint, {
			fingerprint,
			name,
			createdAt: new Date(),
		});

		return { fingerprint, name, createdAt: new Date() };
	}

	/** 删除密钥 */
	async deleteKey(fingerprint: string): Promise<void> {
		await this.storage.setSecret(
			fingerprintToStorageKey(fingerprint),
			"",
		);
		// 从元数据列表中移除
		const allMeta = await this.loadAllKeyMeta();
		const filtered = allMeta.filter((k) => k.fingerprint !== fingerprint);
		await this.storage.setSecret(
			SECRET_STORAGE_META_KEY,
			JSON.stringify(filtered),
		);
	}

	/** 获取密钥用于解密 */
	async getKey(fingerprint: string): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(
			fingerprintToStorageKey(fingerprint),
		);
		if (!stored) return;
		const raw = new Uint8Array(base64ToArrayBuffer(stored));
		return importKeyRaw(raw);
	}

	/** 获取密钥同时可用于加密 */
	async getKeyForEncrypt(
		fingerprint: string,
	): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(
			fingerprintToStorageKey(fingerprint),
		);
		if (!stored) return;
		const raw = new Uint8Array(base64ToArrayBuffer(stored));
		return importKeyRawEncrypt(raw);
	}

	/** 检查指定密钥是否存在 */
	async hasKey(fingerprint: string): Promise<boolean> {
		const stored = await this.storage.getSecret(
			fingerprintToStorageKey(fingerprint),
		);
		return !!stored;
	}

	/** 列出所有密钥信息 */
	async listKeys(): Promise<EncryptionKeyInfo[]> {
		return this.loadAllKeyMeta();
	}

	/** 导出密钥（base64 编码）供备份 */
	async exportKey(fingerprint: string): Promise<string | undefined> {
		const result = await this.storage.getSecret(
			fingerprintToStorageKey(fingerprint),
		);
		return result ?? undefined;
	}

	/** 导入密钥 */
	async importKey(
		name: string,
		keyMaterialBase64: string,
	): Promise<EncryptionKeyInfo> {
		const raw = new Uint8Array(base64ToArrayBuffer(keyMaterialBase64));
		const fingerprint = await computeFingerprint(raw);

		// 检查是否已存在
		const existing = await this.storage.getSecret(
			fingerprintToStorageKey(fingerprint),
		);
		if (existing) {
			throw new Error(`Key with fingerprint ${fingerprint} already exists`);
		}

		// 验证密钥材料有效
		await importKeyRawEncrypt(raw);

		await this.storage.setSecret(
			fingerprintToStorageKey(fingerprint),
			keyMaterialBase64,
		);
		await this.saveKeyMeta(fingerprint, {
			fingerprint,
			name,
			createdAt: new Date(),
		});

		return { fingerprint, name, createdAt: new Date() };
	}

	private async loadAllKeyMeta(): Promise<EncryptionKeyInfo[]> {
		const stored = await this.storage.getSecret(
			SECRET_STORAGE_META_KEY,
		);
		if (!stored) return [];
		try {
			const parsed = JSON.parse(stored);
			return parsed.map((k: Record<string, string>) => ({
				...k,
				createdAt: new Date(k.createdAt),
			}));
		} catch {
			return [];
		}
	}

	private async saveKeyMeta(
		fingerprint: string,
		info: EncryptionKeyInfo,
	): Promise<void> {
		const allMeta = await this.loadAllKeyMeta();
		const existing = allMeta.findIndex(
			(k) => k.fingerprint === fingerprint,
		);
		if (existing >= 0) {
			allMeta[existing] = info;
		} else {
			allMeta.push(info);
		}
		await this.storage.setSecret(
			SECRET_STORAGE_META_KEY,
			JSON.stringify(allMeta),
		);
	}

}

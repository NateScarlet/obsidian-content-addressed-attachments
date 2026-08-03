import * as cryptoUtils from "./cryptoUtils";
import {
	type EncryptionKeyInfo,
	type KeyStorage,
	type SecretEntry,
} from "./types";
import type { Settings } from "#src/settings";

/** 默认存储密钥的 secret ID */
export const DEFAULT_KEYS_STORAGE_ID = "encryption-keys-w1kxt3qz";

/** 密钥存储 JSON 格式 */
interface KeysStorageData {
	version: 1;
	keys: Record<string, SecretEntry>;
}

export default class KeyManager {
	constructor(
		private storage: KeyStorage,
		private getSettings: () => Pick<Settings, "encryptionKeysSecretId">,
		private saveSettings: () => Promise<void>,
	) {}

	/** 获取当前存储密钥的 secret ID */
	getKeysStorageId(): string {
		return (
			this.getSettings().encryptionKeysSecretId || DEFAULT_KEYS_STORAGE_ID
		);
	}

	/** 设置存储密钥的 secret ID，切换时校验新 ID 下已有数据确保格式兼容 */
	async setKeysStorageId(id: string): Promise<void> {
		// 校验新 ID 下的已有数据，避免意外覆盖其他密钥
		const stored = await this.storage.getSecret(id);
		if (stored) {
			try {
				const data = JSON.parse(stored) as {
					version?: unknown;
					keys?: unknown;
				};
				if (
					data.version !== 1 ||
					!data.keys ||
					typeof data.keys !== "object"
				) {
					throw new Error("Invalid keys storage format");
				}
			} catch {
				throw new Error(
					`Secret "${id}" already contains data that is not a valid keys storage. ` +
						`Choose a different ID to avoid overwriting existing secrets.`,
				);
			}
		}
		const settings = this.getSettings();
		settings.encryptionKeysSecretId = id;
		await this.saveSettings();
		// 重新加载新 ID 下的密钥数据，确保数据一致性
		await this.loadKeysData();
	}

	/** 读取并解析密钥存储数据 */
	private async loadKeysData(): Promise<KeysStorageData> {
		const stored = await this.storage.getSecret(this.getKeysStorageId());
		if (!stored) {
			return { version: 1, keys: {} };
		}
		try {
			const data = JSON.parse(stored) as KeysStorageData;
			if (data.version !== 1 || !data.keys) {
				throw new Error("Invalid keys storage format");
			}
			return data;
		} catch (err) {
			throw new Error(
				`Failed to parse keys storage: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** 保存密钥存储数据 */
	private async saveKeysData(data: KeysStorageData): Promise<void> {
		await this.storage.setSecret(
			this.getKeysStorageId(),
			JSON.stringify(data, null, 2),
		);
	}

	async createKey(name: string): Promise<EncryptionKeyInfo> {
		const key = await cryptoUtils.generateKey();
		const raw = await cryptoUtils.exportKeyRaw(key);
		const fingerprint = await cryptoUtils.computeFingerprint(raw);
		const priority = 0;

		const data = await this.loadKeysData();
		data.keys[fingerprint] = {
			key: cryptoUtils.arrayBufferToBase64(raw.buffer as ArrayBuffer),
			name,
			createdAt: new Date().toISOString(),
			priority,
		};
		await this.saveKeysData(data);

		return { fingerprint, name, createdAt: new Date(), priority };
	}

	async setPrimaryKey(fingerprint: string): Promise<void> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry || entry.deletedAt)
			throw new Error(`Key ${fingerprint} not found`);

		const all = await this.listKeys();
		const maxPriority = all.reduce(
			(max, k) => Math.max(max, k.priority),
			0,
		);
		entry.priority = maxPriority + 1;
		await this.saveKeysData(data);
	}

	/** 软删除：设置 deletedAt 为当前时间 */
	async deleteKey(fingerprint: string): Promise<void> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry) throw new Error(`Key ${fingerprint} not found`);
		entry.deletedAt = new Date().toISOString();
		await this.saveKeysData(data);
	}

	/** 恢复已软删除的密钥 */
	async restoreKey(fingerprint: string): Promise<void> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry || !entry.deletedAt)
			throw new Error(`Key ${fingerprint} is not deleted`);
		delete entry.deletedAt;
		await this.saveKeysData(data);
	}

	/** 永久删除超过指定天数的已删除密钥 */
	async permanentlyDeleteKeys(olderThanDays: number): Promise<number> {
		const data = await this.loadKeysData();
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - olderThanDays);

		let count = 0;
		for (const [fingerprint, entry] of Object.entries(data.keys)) {
			if (entry.deletedAt && new Date(entry.deletedAt) <= cutoff) {
				delete data.keys[fingerprint];
				count++;
			}
		}
		if (count > 0) {
			await this.saveKeysData(data);
		}
		return count;
	}

	async getKey(fingerprint: string): Promise<CryptoKey | undefined> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry) return undefined;
		const raw = cryptoUtils.base64ToArrayBuffer(entry.key);
		return cryptoUtils.importKeyRaw(new Uint8Array(raw));
	}

	async getKeyForEncrypt(
		fingerprint: string,
	): Promise<CryptoKey | undefined> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry || entry.deletedAt) return undefined;
		const raw = cryptoUtils.base64ToArrayBuffer(entry.key);
		return cryptoUtils.importKeyRawEncrypt(new Uint8Array(raw));
	}

	/** 列出所有未被删除的密钥，按 priority 降序 */
	async listKeys(): Promise<EncryptionKeyInfo[]> {
		const data = await this.loadKeysData();
		const results: EncryptionKeyInfo[] = [];
		for (const [fingerprint, entry] of Object.entries(data.keys)) {
			if (entry.deletedAt) continue;
			results.push({
				fingerprint,
				name: entry.name ?? "",
				createdAt: new Date(entry.createdAt),
				priority: entry.priority ?? 0,
			});
		}
		results.sort((a, b) => b.priority - a.priority);
		return results;
	}

	/** 列出已删除的密钥，按 deletedAt 降序 */
	async listDeletedKeys(): Promise<EncryptionKeyInfo[]> {
		const data = await this.loadKeysData();
		const results: EncryptionKeyInfo[] = [];
		for (const [fingerprint, entry] of Object.entries(data.keys)) {
			if (!entry.deletedAt) continue;
			results.push({
				fingerprint,
				name: entry.name ?? "",
				createdAt: new Date(entry.createdAt),
				priority: entry.priority ?? 0,
				deletedAt: new Date(entry.deletedAt),
			});
		}
		results.sort(
			(a, b) =>
				(b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0),
		);
		return results;
	}

	async getPrimaryKey(): Promise<EncryptionKeyInfo | undefined> {
		const all = await this.listKeys();
		return all[0];
	}

	async renameKey(fingerprint: string, newName: string): Promise<void> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry || entry.deletedAt)
			throw new Error(`Key ${fingerprint} not found`);
		entry.name = newName;
		await this.saveKeysData(data);
	}

	async exportAllKeys(passphrase: string): Promise<string> {
		const data = await this.loadKeysData();
		const entries = Object.entries(data.keys).map(
			([fingerprint, entry]) => ({
				fingerprint,
				key: entry.key,
				name: entry.name ?? "",
				createdAt: entry.createdAt,
				priority: entry.priority ?? 0,
				deletedAt: entry.deletedAt,
			}),
		);
		const plaintext = JSON.stringify(entries, null, 2);
		return cryptoUtils.encryptWithPassphrase(plaintext, passphrase);
	}

	async importAllKeys(
		encryptedJson: string,
		passphrase: string,
	): Promise<number> {
		const plaintext = await cryptoUtils.decryptWithPassphrase(
			encryptedJson,
			passphrase,
		);
		const entries = JSON.parse(plaintext) as Array<{
			fingerprint: string;
			key: string;
			name: string;
			createdAt: string;
			priority: number;
			deletedAt?: string;
		}>;

		const data = await this.loadKeysData();
		let imported = 0;
		for (const entry of entries) {
			const existing = data.keys[entry.fingerprint];
			if (existing && !existing.deletedAt) continue;
			const raw = new Uint8Array(
				cryptoUtils.base64ToArrayBuffer(entry.key),
			);
			await cryptoUtils.importKeyRawEncrypt(raw);
			data.keys[entry.fingerprint] = {
				key: entry.key,
				name: entry.name,
				createdAt: entry.createdAt,
				priority: entry.priority ?? 0,
			};
			imported++;
		}
		await this.saveKeysData(data);
		return imported;
	}
}

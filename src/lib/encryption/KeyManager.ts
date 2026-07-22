import { CryptoService } from "./CryptoService";
import {
	type EncryptionKeyInfo,
	type KeyStorage,
	type SecretEntry,
} from "./types";

/** 默认存储密钥的 secret ID */
export const DEFAULT_KEYS_STORAGE_ID = "encryption-keys-w1kxt3qz";

/** 密钥存储 JSON 格式 */
interface KeysStorageData {
	version: 1;
	keys: Record<string, SecretEntry>;
}

export class KeyManager {
	private keysStorageId: string = DEFAULT_KEYS_STORAGE_ID;

	constructor(
		private storage: KeyStorage,
		private available = true,
		private cryptoService = new CryptoService(),
	) {}

	get isAvailable(): boolean {
		return this.available && Boolean(this.storage);
	}

	/** 获取当前存储密钥的 secret ID */
	getKeysStorageId(): string {
		return this.keysStorageId;
	}

	/** 设置存储密钥的 secret ID */
	setKeysStorageId(id: string): void {
		this.keysStorageId = id;
	}

	/** 读取并解析密钥存储数据 */
	private async loadKeysData(): Promise<KeysStorageData> {
		const stored = await this.storage.getSecret(this.keysStorageId);
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
			this.keysStorageId,
			JSON.stringify(data, null, 2),
		);
	}

	async createKey(name: string): Promise<EncryptionKeyInfo> {
		const key = await this.cryptoService.generateKey();
		const raw = await this.cryptoService.exportKeyRaw(key);
		const fingerprint = await this.cryptoService.computeFingerprint(raw);
		const priority = 0;

		const data = await this.loadKeysData();
		data.keys[fingerprint] = {
			key: this.cryptoService.arrayBufferToBase64(raw.buffer as ArrayBuffer),
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
		if (!entry) throw new Error(`Key ${fingerprint} not found`);

		const all = await this.listKeys();
		const maxPriority = all.reduce((max, k) => Math.max(max, k.priority), 0);
		entry.priority = maxPriority + 1;
		await this.saveKeysData(data);
	}

	async deleteKey(fingerprint: string): Promise<void> {
		const data = await this.loadKeysData();
		delete data.keys[fingerprint];
		await this.saveKeysData(data);
	}

	async getKey(fingerprint: string): Promise<CryptoKey | undefined> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry) return;
		const raw = new Uint8Array(
			this.cryptoService.base64ToArrayBuffer(entry.key),
		);
		return this.cryptoService.importKeyRaw(raw);
	}

	async getKeyForEncrypt(fingerprint: string): Promise<CryptoKey | undefined> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry) return;
		const raw = new Uint8Array(
			this.cryptoService.base64ToArrayBuffer(entry.key),
		);
		return this.cryptoService.importKeyRawEncrypt(raw);
	}

	async hasKey(fingerprint: string): Promise<boolean> {
		const data = await this.loadKeysData();
		return fingerprint in data.keys;
	}

	async listKeys(): Promise<EncryptionKeyInfo[]> {
		const data = await this.loadKeysData();
		const results: EncryptionKeyInfo[] = [];
		for (const [fingerprint, entry] of Object.entries(data.keys)) {
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

	async getPrimaryKey(): Promise<EncryptionKeyInfo | undefined> {
		const all = await this.listKeys();
		return all[0];
	}

	async exportKey(fingerprint: string): Promise<string | undefined> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		return entry?.key;
	}

	async renameKey(fingerprint: string, newName: string): Promise<void> {
		const data = await this.loadKeysData();
		const entry = data.keys[fingerprint];
		if (!entry) throw new Error(`Key ${fingerprint} not found`);
		entry.name = newName;
		await this.saveKeysData(data);
	}

	async exportAllKeys(passphrase: string): Promise<string> {
		const data = await this.loadKeysData();
		const entries = Object.entries(data.keys).map(([fingerprint, entry]) => ({
			fingerprint,
			key: entry.key,
			name: entry.name ?? "",
			createdAt: entry.createdAt,
			priority: entry.priority ?? 0,
		}));
		const plaintext = JSON.stringify(entries, null, 2);
		return this.cryptoService.encryptWithPassphrase(plaintext, passphrase);
	}

	async importAllKeys(
		encryptedJson: string,
		passphrase: string,
	): Promise<number> {
		const plaintext = await this.cryptoService.decryptWithPassphrase(
			encryptedJson,
			passphrase,
		);
		const entries = JSON.parse(plaintext) as Array<{
			fingerprint: string;
			key: string;
			name: string;
			createdAt: string;
			priority: number;
		}>;

		const data = await this.loadKeysData();
		let imported = 0;
		for (const entry of entries) {
			if (data.keys[entry.fingerprint]) continue;
			const raw = new Uint8Array(
				this.cryptoService.base64ToArrayBuffer(entry.key),
			);
			await this.cryptoService.importKeyRawEncrypt(raw);
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

	async importKey(
		name: string,
		keyMaterialBase64: string,
	): Promise<EncryptionKeyInfo> {
		const raw = new Uint8Array(
			this.cryptoService.base64ToArrayBuffer(keyMaterialBase64),
		);
		const fingerprint = await this.cryptoService.computeFingerprint(raw);

		const data = await this.loadKeysData();
		if (data.keys[fingerprint]) {
			throw new Error(`Key with fingerprint ${fingerprint} already exists`);
		}

		await this.cryptoService.importKeyRawEncrypt(raw);

		data.keys[fingerprint] = {
			key: keyMaterialBase64,
			name,
			createdAt: new Date().toISOString(),
			priority: 0,
		};
		await this.saveKeysData(data);

		return { fingerprint, name, createdAt: new Date(), priority: 0 };
	}
}

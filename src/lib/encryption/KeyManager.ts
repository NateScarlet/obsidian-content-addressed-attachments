import { CryptoService } from "./CryptoService";
import {
	type EncryptionKeyInfo,
	type KeyStorage,
	type SecretEntry,
} from "./types";

const STORAGE_KEY_PREFIX = "content-addressed-attachments-";

function toStorageKey(fingerprint: string): string {
	return `${STORAGE_KEY_PREFIX}${fingerprint}`;
}

export class KeyManager {
	constructor(
		private storage: KeyStorage,
		private available = true,
		private cryptoService = new CryptoService(),
	) {}

	get isAvailable(): boolean {
		return this.available && Boolean(this.storage);
	}

	async createKey(name: string): Promise<EncryptionKeyInfo> {
		const key = await this.cryptoService.generateKey();
		const raw = await this.cryptoService.exportKeyRaw(key);
		const fingerprint = await this.cryptoService.computeFingerprint(raw);
		const priority = 0;

		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify({
				key: this.cryptoService.arrayBufferToBase64(
					raw.buffer as ArrayBuffer,
				),
				name,
				createdAt: new Date().toISOString(),
				priority,
			}),
		);

		return { fingerprint, name, createdAt: new Date(), priority };
	}

	async setPrimaryKey(fingerprint: string): Promise<void> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) throw new Error(`Key ${fingerprint} not found`);
		const entry = JSON.parse(stored) as SecretEntry;
		const all = await this.listKeys();
		const maxPriority = all.reduce(
			(max, k) => Math.max(max, k.priority),
			0,
		);
		entry.priority = maxPriority + 1;
		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify(entry),
		);
	}

	async deleteKey(fingerprint: string): Promise<void> {
		const storage = this.storage as {
			deleteSecret?: (key: string) => void | Promise<void>;
		};
		if (storage.deleteSecret) {
			await storage.deleteSecret(toStorageKey(fingerprint));
		} else {
			// Fallback for storage without deleteSecret
			await this.storage.setSecret(toStorageKey(fingerprint), "");
		}
	}

	async getKey(fingerprint: string): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		const entry = JSON.parse(stored) as SecretEntry;
		const raw = new Uint8Array(
			this.cryptoService.base64ToArrayBuffer(entry.key),
		);
		return this.cryptoService.importKeyRaw(raw);
	}

	async getKeyForEncrypt(
		fingerprint: string,
	): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		const entry = JSON.parse(stored) as SecretEntry;
		const raw = new Uint8Array(
			this.cryptoService.base64ToArrayBuffer(entry.key),
		);
		return this.cryptoService.importKeyRawEncrypt(raw);
	}

	async hasKey(fingerprint: string): Promise<boolean> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		return !!stored;
	}

	async listKeys(): Promise<EncryptionKeyInfo[]> {
		const all = await this.storage.listSecrets();
		const results: EncryptionKeyInfo[] = [];
		for (const id of all) {
			if (!id.startsWith(STORAGE_KEY_PREFIX)) continue;
			const stored = await this.storage.getSecret(id);
			if (!stored) continue;
			try {
				const entry = JSON.parse(stored) as SecretEntry;
				const fingerprint = id.slice(STORAGE_KEY_PREFIX.length);
				results.push({
					fingerprint,
					name: entry.name ?? "",
					createdAt: new Date(entry.createdAt),
					priority: entry.priority ?? 0,
				});
			} catch {
				// skip corrupted entries
			}
		}
		results.sort((a, b) => b.priority - a.priority);
		return results;
	}

	async getPrimaryKey(): Promise<EncryptionKeyInfo | undefined> {
		const all = await this.listKeys();
		return all[0];
	}

	async exportKey(fingerprint: string): Promise<string | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		try {
			const entry = JSON.parse(stored) as SecretEntry;
			return entry.key;
		} catch {
			return stored ?? undefined;
		}
	}

	async renameKey(fingerprint: string, newName: string): Promise<void> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) throw new Error(`Key ${fingerprint} not found`);
		const entry = JSON.parse(stored) as SecretEntry;
		entry.name = newName;
		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify(entry),
		);
	}

	async exportAllKeys(passphrase: string): Promise<string> {
		const all = await this.storage.listSecrets();
		const entries: Array<{
			fingerprint: string;
			key: string;
			name: string;
			createdAt: string;
			priority: number;
		}> = [];
		for (const id of all) {
			if (!id.startsWith(STORAGE_KEY_PREFIX)) continue;
			const stored = await this.storage.getSecret(id);
			if (!stored) continue;
			try {
				const entry = JSON.parse(stored) as SecretEntry;
				const fingerprint = id.slice(STORAGE_KEY_PREFIX.length);
				entries.push({
					fingerprint,
					key: entry.key,
					name: entry.name ?? "",
					createdAt: entry.createdAt,
					priority: entry.priority ?? 0,
				});
			} catch {
				// skip corrupted entries
			}
		}
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
		let imported = 0;
		for (const entry of entries) {
			const existing = await this.storage.getSecret(
				toStorageKey(entry.fingerprint),
			);
			if (existing) continue;
			const raw = new Uint8Array(
				this.cryptoService.base64ToArrayBuffer(entry.key),
			);
			await this.cryptoService.importKeyRawEncrypt(raw);
			await this.storage.setSecret(
				toStorageKey(entry.fingerprint),
				JSON.stringify({
					key: entry.key,
					name: entry.name,
					createdAt: entry.createdAt,
					priority: entry.priority ?? 0,
				}),
			);
			imported++;
		}
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

		const existing = await this.storage.getSecret(
			toStorageKey(fingerprint),
		);
		if (existing) {
			throw new Error(
				`Key with fingerprint ${fingerprint} already exists`,
			);
		}

		await this.cryptoService.importKeyRawEncrypt(raw);

		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify({
				key: keyMaterialBase64,
				name,
				createdAt: new Date().toISOString(),
				priority: 0,
			}),
		);

		return { fingerprint, name, createdAt: new Date(), priority: 0 };
	}
}

import {
	generateKey,
	exportKeyRaw,
	importKeyRawEncrypt,
	importKeyRaw,
	computeFingerprint,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	encryptWithPassphrase,
	decryptWithPassphrase,
} from "./CryptoService";
import {
	STORAGE_KEY_PREFIX,
	type EncryptionKeyInfo,
	type KeyStorage,
} from "./types";

function toStorageKey(fingerprint: string): string {
	return `${STORAGE_KEY_PREFIX}${fingerprint}`;
}

export class KeyManager {
	constructor(
		private storage: KeyStorage,
		private _isAvailable = true,
	) {}

	get isAvailable(): boolean {
		return this._isAvailable;
	}

	async createKey(name: string): Promise<EncryptionKeyInfo> {
		const key = await generateKey();
		const raw = await exportKeyRaw(key);
		const fingerprint = await computeFingerprint(raw);

		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify({
				key: arrayBufferToBase64(raw.buffer as ArrayBuffer),
				name,
				createdAt: new Date().toISOString(),
			}),
		);

		return { fingerprint, name, createdAt: new Date() };
	}

	async deleteKey(fingerprint: string): Promise<void> {
		await this.storage.setSecret(toStorageKey(fingerprint), "");
	}

	async getKey(fingerprint: string): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		const entry = JSON.parse(stored);
		const raw = new Uint8Array(base64ToArrayBuffer(entry.key));
		return importKeyRaw(raw);
	}

	async getKeyForEncrypt(
		fingerprint: string,
	): Promise<CryptoKey | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		const entry = JSON.parse(stored);
		const raw = new Uint8Array(base64ToArrayBuffer(entry.key));
		return importKeyRawEncrypt(raw);
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
				const entry = JSON.parse(stored);
				const fingerprint = id.slice(STORAGE_KEY_PREFIX.length);
				results.push({
					fingerprint,
					name: entry.name,
					createdAt: new Date(entry.createdAt),
				});
			} catch {
				// skip corrupted entries
			}
		}
		return results;
	}

	async exportKey(fingerprint: string): Promise<string | undefined> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) return;
		try {
			const entry = JSON.parse(stored);
			return entry.key;
		} catch {
			return stored ?? undefined;
		}
	}

	async renameKey(fingerprint: string, newName: string): Promise<void> {
		const stored = await this.storage.getSecret(toStorageKey(fingerprint));
		if (!stored) throw new Error(`Key ${fingerprint} not found`);
		const entry = JSON.parse(stored);
		entry.name = newName;
		await this.storage.setSecret(toStorageKey(fingerprint), JSON.stringify(entry));
	}

	async exportAllKeys(passphrase: string): Promise<string> {
		const all = await this.storage.listSecrets();
		const entries: Array<{ fingerprint: string; key: string; name: string; createdAt: string }> = [];
		for (const id of all) {
			if (!id.startsWith(STORAGE_KEY_PREFIX)) continue;
			const stored = await this.storage.getSecret(id);
			if (!stored) continue;
			try {
				const entry = JSON.parse(stored);
				const fingerprint = id.slice(STORAGE_KEY_PREFIX.length);
				entries.push({ fingerprint, key: entry.key, name: entry.name, createdAt: entry.createdAt });
			} catch {
				// skip corrupted entries
			}
		}
		const plaintext = JSON.stringify(entries, null, 2);
		return encryptWithPassphrase(plaintext, passphrase);
	}

	async importAllKeys(encryptedJson: string, passphrase: string): Promise<number> {
		const plaintext = await decryptWithPassphrase(encryptedJson, passphrase);
		const entries: Array<{ fingerprint: string; key: string; name: string; createdAt: string }> = JSON.parse(plaintext);
		let imported = 0;
		for (const entry of entries) {
			const existing = await this.storage.getSecret(toStorageKey(entry.fingerprint));
			if (existing) continue;
			const raw = new Uint8Array(base64ToArrayBuffer(entry.key));
			await importKeyRawEncrypt(raw);
			await this.storage.setSecret(
				toStorageKey(entry.fingerprint),
				JSON.stringify({ key: entry.key, name: entry.name, createdAt: entry.createdAt }),
			);
			imported++;
		}
		return imported;
	}

	async importKey(
		name: string,
		keyMaterialBase64: string,
	): Promise<EncryptionKeyInfo> {
		const raw = new Uint8Array(base64ToArrayBuffer(keyMaterialBase64));
		const fingerprint = await computeFingerprint(raw);

		const existing = await this.storage.getSecret(toStorageKey(fingerprint));
		if (existing) {
			throw new Error(`Key with fingerprint ${fingerprint} already exists`);
		}

		await importKeyRawEncrypt(raw);

		await this.storage.setSecret(
			toStorageKey(fingerprint),
			JSON.stringify({
				key: keyMaterialBase64,
				name,
				createdAt: new Date().toISOString(),
			}),
		);

		return { fingerprint, name, createdAt: new Date() };
	}
}

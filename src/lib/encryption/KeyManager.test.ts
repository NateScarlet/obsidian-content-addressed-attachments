import { describe, it, expect, beforeEach } from "vitest";
import { KeyManager } from "./KeyManager";
import type { KeyStorage, SecretEntry } from "./types";
import { CryptoService } from "./CryptoService";

function createMockStorage(): KeyStorage {
	const store = new Map<string, string>();
	return {
		getSecret(key: string) {
			return store.get(key);
		},
		setSecret(key: string, value: string) {
			store.set(key, value);
		},
		listSecrets() {
			return Array.from(store.keys());
		},
	};
}

describe("KeyManager", () => {
	let storage: KeyStorage;
	let km: KeyManager;

	beforeEach(() => {
		storage = createMockStorage();
		km = new KeyManager(storage);
	});

	describe("isAvailable", () => {
		it("returns true when storage is provided", () => {
			expect(km.isAvailable).toBe(true);
		});

		it("returns false when created with unavailable flag", () => {
			const unavailable = new KeyManager(storage, false);
			expect(unavailable.isAvailable).toBe(false);
		});
	});

	describe("createKey", () => {
		it("creates a key with given name", async () => {
			const info = await km.createKey("my-key");
			expect(info.name).toBe("my-key");
			expect(info.fingerprint).toBeTruthy();
			expect(info.createdAt).toBeInstanceOf(Date);
		});

		it("creates a key with empty name", async () => {
			const info = await km.createKey("");
			expect(info.name).toBe("");
			expect(info.fingerprint).toBeTruthy();
			expect(info.createdAt).toBeInstanceOf(Date);
		});

		it("persists key data to storage", async () => {
			const info = await km.createKey("persisted");
			const stored = await storage.getSecret(
				`content-addressed-attachments-${info.fingerprint}`,
			);
			expect(stored).toBeTruthy();

			const entry = JSON.parse(stored!) as SecretEntry;
			expect(entry.name).toBe("persisted");
			expect(entry.key).toBeTruthy();
			expect(entry.createdAt).toBeTruthy();
		});

		it("returns different fingerprints for consecutive keys", async () => {
			const k1 = await km.createKey("k1");
			const k2 = await km.createKey("k2");
			expect(k1.fingerprint).not.toBe(k2.fingerprint);
		});
	});

	describe("listKeys", () => {
		it("returns empty list when no keys exist", async () => {
			const keys = await km.listKeys();
			expect(keys).toEqual([]);
		});

		it("returns all created keys", async () => {
			await km.createKey("key1");
			await km.createKey("key2");
			const keys = await km.listKeys();
			expect(keys).toHaveLength(2);
			const names = keys.map((k) => k.name);
			expect(names).toContain("key1");
			expect(names).toContain("key2");
		});

		it("listKeys returns keys sorted by priority descending", async () => {
			const k1 = await km.createKey("key1");
			const k2 = await km.createKey("key2");

			await km.setPrimaryKey(k2.fingerprint);

			const keys = await km.listKeys();
			expect(keys[0].fingerprint).toBe(k2.fingerprint);
			expect(keys[1].fingerprint).toBe(k1.fingerprint);
		});
	});

	describe("getPrimaryKey", () => {
		it("returns undefined when no keys exist", async () => {
			expect(await km.getPrimaryKey()).toBeUndefined();
		});

		it("returns the key with highest priority", async () => {
			await km.createKey("first");
			const k2 = await km.createKey("second");

			// Initially first key listed
			const primary1 = await km.getPrimaryKey();
			expect(primary1?.fingerprint).toBeDefined();

			// Promote k2
			await km.setPrimaryKey(k2.fingerprint);
			const primary2 = await km.getPrimaryKey();
			expect(primary2?.fingerprint).toBe(k2.fingerprint);
		});
	});

	describe("setPrimaryKey", () => {
		it("setPrimaryKey promotes a key to highest priority", async () => {
			await km.createKey("k1");
			const k2 = await km.createKey("k2");

			await km.setPrimaryKey(k2.fingerprint);

			const primary = await km.getPrimaryKey();
			expect(primary?.fingerprint).toBe(k2.fingerprint);
			expect(primary?.name).toBe("k2");
		});

		it("setPrimaryKey throws for nonexistent key", async () => {
			await expect(km.setPrimaryKey("nonexistent")).rejects.toThrow(
				"not found",
			);
		});
	});

	describe("hasKey", () => {
		it("returns true for existing key", async () => {
			const info = await km.createKey("test");
			expect(await km.hasKey(info.fingerprint)).toBe(true);
		});

		it("returns false for nonexistent key", async () => {
			expect(await km.hasKey("nonexistent")).toBe(false);
		});
	});

	describe("getKey / getKeyForEncrypt", () => {
		it("returns CryptoKey for decrypt", async () => {
			const info = await km.createKey("test");
			const key = await km.getKey(info.fingerprint);
			expect(key).toBeDefined();
			expect(key!.algorithm.name).toBe("AES-GCM");
		});

		it("returns CryptoKey for encrypt with encrypt+decrypt usages", async () => {
			const info = await km.createKey("test");
			const key = await km.getKeyForEncrypt(info.fingerprint);
			expect(key).toBeDefined();
			expect(key!.usages).toContain("encrypt");
			expect(key!.usages).toContain("decrypt");
		});

		it("returns undefined for unknown fingerprint", async () => {
			expect(await km.getKey("unknown")).toBeUndefined();
			expect(await km.getKeyForEncrypt("unknown")).toBeUndefined();
		});
	});

	describe("deleteKey", () => {
		it("removes key from storage", async () => {
			const info = await km.createKey("to-delete");
			await km.deleteKey(info.fingerprint);
			expect(await km.hasKey(info.fingerprint)).toBe(false);
		});

		it("removes key from key listing", async () => {
			const info = await km.createKey("to-delete");
			await km.deleteKey(info.fingerprint);
			const keys = await km.listKeys();
			expect(keys).toHaveLength(0);
		});
	});

	describe("renameKey", () => {
		it("renames an existing key", async () => {
			const info = await km.createKey("old-name");
			await km.renameKey(info.fingerprint, "new-name");

			const keys = await km.listKeys();
			expect(keys[0].name).toBe("new-name");
		});

		it("throws for nonexistent key", async () => {
			await expect(km.renameKey("nonexistent", "name")).rejects.toThrow(
				"not found",
			);
		});
	});

	describe("exportKey / importKey", () => {
		it("exports key material for an existing key", async () => {
			const info = await km.createKey("to-export");
			const exported = await km.exportKey(info.fingerprint);
			expect(exported).toBeTruthy();
			expect(typeof exported).toBe("string");
		});

		it("returns undefined for nonexistent key", async () => {
			expect(await km.exportKey("nonexistent")).toBeUndefined();
		});

		it("imports exported key material", async () => {
			const info = await km.createKey("original");
			const exported = (await km.exportKey(info.fingerprint))!;

			const km2 = new KeyManager(createMockStorage());
			const imported = await km2.importKey("imported", exported);

			expect(imported.fingerprint).toBe(info.fingerprint);
			expect(imported.name).toBe("imported");
			expect(await km2.hasKey(info.fingerprint)).toBe(true);
		});

		it("rejects duplicate import", async () => {
			const info = await km.createKey("unique");
			const exported = (await km.exportKey(info.fingerprint))!;

			await expect(km.importKey("duplicate", exported)).rejects.toThrow(
				"already exists",
			);
		});
	});

	describe("exportAllKeys / importAllKeys", () => {
		it("exports all keys encrypted with passphrase", async () => {
			await km.createKey("key1");
			await km.createKey("key2");
			const encrypted = await km.exportAllKeys("backup-pass");
			expect(encrypted).toBeTruthy();

			const plaintext = await new CryptoService().decryptWithPassphrase(
				encrypted,
				"backup-pass",
			);
			const parsed = JSON.parse(plaintext) as unknown[];
			expect(parsed).toHaveLength(2);
		});

		it("imports keys from backup", async () => {
			const origKm = new KeyManager(createMockStorage());
			await origKm.createKey("imported-key");
			const encrypted = await origKm.exportAllKeys("pass");

			// start fresh — no keys
			expect(await km.listKeys()).toHaveLength(0);

			const count = await km.importAllKeys(encrypted, "pass");
			expect(count).toBe(1);

			const keys = await km.listKeys();
			expect(keys).toHaveLength(1);
			expect(keys[0].name).toBe("imported-key");
		});

		it("reuses existing keys on import (skips duplicates)", async () => {
			const origKm = new KeyManager(createMockStorage());
			const k1 = await origKm.createKey("existing");
			const exportedAll = await origKm.exportAllKeys("pass");

			// Pre-populate km with same key material
			const rawKey = (await origKm.exportKey(k1.fingerprint))!;
			await km.importKey("existing", rawKey);

			// Import backup containing duplicate
			const count = await km.importAllKeys(exportedAll, "pass");
			expect(count).toBe(0); // skipped 1 duplicate
			expect(await km.listKeys()).toHaveLength(1);
		});
	});
});

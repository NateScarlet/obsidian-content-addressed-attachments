import { describe, it, expect, beforeEach } from "vitest";
import { KeyManager } from "#src/lib/encryption/KeyManager";
import type { KeyStorage } from "#src/lib/encryption/types";
import { decryptWithPassphrase } from "#src/lib/encryption/CryptoService";

function createMockStorage(): KeyStorage {
	const store = new Map<string, string>();
	return {
		async getSecret(key: string) { return store.get(key); },
		async setSecret(key: string, value: string) { store.set(key, value); },
		async listSecrets() { return Array.from(store.keys()); },
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
			const km2 = new KeyManager(createMockStorage(), false);
			expect(km2.isAvailable).toBe(false);
		});
	});

	describe("createKey", () => {
		it("creates a key with given name", async () => {
			const info = await km.createKey("my-key");
			expect(info.name).toBe("my-key");
			expect(info.fingerprint).toBeTruthy();
			expect(info.createdAt).toBeInstanceOf(Date);
			expect(info.priority).toBe(0);
		});

		it("creates a key with empty name", async () => {
			const info = await km.createKey("");
			expect(info.name).toBe("");
			expect(info.fingerprint).toBeTruthy();
		});

		it("persists key data to storage", async () => {
			const info = await km.createKey("test-key");
			const raw = await storage.getSecret(
				`content-addressed-attachments-${info.fingerprint}`,
			);
			expect(raw).toBeTruthy();
			const entry = JSON.parse(raw!);
			expect(entry.key).toBeTruthy();
			expect(entry.name).toBe("test-key");
			expect(entry.priority).toBe(0);
		});

		it("returns different fingerprints for consecutive keys", async () => {
			const k1 = await km.createKey("key1");
			const k2 = await km.createKey("key2");
			expect(k1.fingerprint).not.toBe(k2.fingerprint);
		});
	});

	describe("listKeys", () => {
		it("returns empty list when no keys exist", async () => {
			const keys = await km.listKeys();
			expect(keys).toEqual([]);
		});

		it("returns all created keys", async () => {
			await km.createKey("alpha");
			await km.createKey("beta");
			const keys = await km.listKeys();
			expect(keys).toHaveLength(2);
			expect(keys.map((k) => k.name)).toEqual(
				expect.arrayContaining(["alpha", "beta"]),
			);
		});
	});

	describe("getPrimaryKey / setPrimaryKey", () => {
		it("returns undefined when no keys exist", async () => {
			expect(await km.getPrimaryKey()).toBeUndefined();
		});

		it("returns the key with highest priority", async () => {
			await km.createKey("a");
			await km.createKey("b");
			const primary = await km.getPrimaryKey();
			expect(primary).toBeDefined();
			// both have priority 0, so the first one (highest priority) is primary
			expect(primary!.priority).toBe(0);
		});

		it("setPrimaryKey promotes a key to highest priority", async () => {
			await km.createKey("a");
			const b = await km.createKey("b");
			await km.setPrimaryKey(b.fingerprint);
			const primary = await km.getPrimaryKey();
			expect(primary!.fingerprint).toBe(b.fingerprint);
			expect(primary!.priority).toBeGreaterThan(0);
			const keys = await km.listKeys();
			expect(keys[0].fingerprint).toBe(b.fingerprint);
		});

		it("setPrimaryKey throws for nonexistent key", async () => {
			await expect(km.setPrimaryKey("ghost")).rejects.toThrow("not found");
		});

		it("listKeys returns keys sorted by priority descending", async () => {
			const a = await km.createKey("a");
			const b = await km.createKey("b");
			const c = await km.createKey("c");

			// all priority 0, order stable
			let keys = await km.listKeys();
			expect(keys[0].fingerprint).toBe(a.fingerprint);

			// promote c
			await km.setPrimaryKey(c.fingerprint);
			keys = await km.listKeys();
			expect(keys[0].fingerprint).toBe(c.fingerprint);
			expect(keys[0].priority).toBeGreaterThan(0);
		});
	});

	describe("hasKey", () => {
		it("returns true for existing key", async () => {
			const info = await km.createKey("exists");
			expect(await km.hasKey(info.fingerprint)).toBe(true);
		});

		it("returns false for nonexistent key", async () => {
			expect(await km.hasKey("nonexistent-fingerprint")).toBe(false);
		});
	});

	describe("getKey / getKeyForEncrypt", () => {
		it("returns CryptoKey for decrypt", async () => {
			const info = await km.createKey("crypto-test");
			const key = await km.getKey(info.fingerprint);
			expect(key).toBeTruthy();
			expect(key!.algorithm.name).toBe("AES-GCM");
		});

		it("returns CryptoKey for encrypt with encrypt+decrypt usages", async () => {
			const info = await km.createKey("enc-test");
			const key = await km.getKeyForEncrypt(info.fingerprint);
			expect(key).toBeTruthy();
			expect(key!.usages).toContain("encrypt");
			expect(key!.usages).toContain("decrypt");
		});

		it("returns undefined for unknown fingerprint", async () => {
			expect(await km.getKey("unknown")).toBeUndefined();
		});
	});

	describe("deleteKey", () => {
		it("removes key from storage", async () => {
			const info = await km.createKey("to-delete");
			expect(await km.hasKey(info.fingerprint)).toBe(true);

			await km.deleteKey(info.fingerprint);
			expect(await km.hasKey(info.fingerprint)).toBe(false);
		});

		it("removes key from key listing", async () => {
			const info = await km.createKey("to-delete");
			await km.deleteKey(info.fingerprint);

			const keys = await km.listKeys();
			expect(keys.find((k) => k.fingerprint === info.fingerprint)).toBeUndefined();
		});
	});

	describe("renameKey", () => {
		it("renames an existing key", async () => {
			const info = await km.createKey("old-name");
			await km.renameKey(info.fingerprint, "new-name");

			const keys = await km.listKeys();
			const renamed = keys.find((k) => k.fingerprint === info.fingerprint);
			expect(renamed?.name).toBe("new-name");
		});

		it("throws for nonexistent key", async () => {
			await expect(km.renameKey("ghost", "name")).rejects.toThrow("not found");
		});
	});

	describe("exportKey / importKey", () => {
		it("exports key material for an existing key", async () => {
			const info = await km.createKey("exportable");
			const exported = await km.exportKey(info.fingerprint);
			expect(exported).toBeTruthy();
			expect(typeof exported).toBe("string");
		});

		it("returns undefined for nonexistent key", async () => {
			expect(await km.exportKey("ghost")).toBeUndefined();
		});

		it("imports exported key material", async () => {
			const original = await km.createKey("original");
			const exported = (await km.exportKey(original.fingerprint))!;

			const importedKm = new KeyManager(createMockStorage());
			const imported = await importedKm.importKey("imported", exported);

			expect(imported.fingerprint).toBe(original.fingerprint);
			expect(imported.name).toBe("imported");
		});

		it("rejects duplicate import", async () => {
			const info = await km.createKey("unique");
			const exported = (await km.exportKey(info.fingerprint))!;

			await expect(km.importKey("duplicate", exported)).rejects.toThrow("already exists");
		});
	});

	describe("exportAllKeys / importAllKeys", () => {
		it("exports all keys encrypted with passphrase", async () => {
			await km.createKey("key1");
			await km.createKey("key2");
			const encrypted = await km.exportAllKeys("backup-pass");
			expect(encrypted).toBeTruthy();

			const plaintext = await decryptWithPassphrase(encrypted, "backup-pass");
			const parsed = JSON.parse(plaintext);
			expect(parsed).toHaveLength(2);
		});

		it("imports keys from backup", async () => {
			const origKm = new KeyManager(createMockStorage());
			await origKm.createKey("imported-key");
			const encrypted = await origKm.exportAllKeys("pass");

			// start fresh — no keys
			expect((await km.listKeys())).toHaveLength(0);

			const count = await km.importAllKeys(encrypted, "pass");
			expect(count).toBe(1);

			const keys = await km.listKeys();
			expect(keys).toHaveLength(1);
			expect(keys[0].name).toBe("imported-key");
		});

		it("reuses existing keys on import (skips duplicates)", async () => {
			const origKm = new KeyManager(createMockStorage());
			await origKm.createKey("dup-key");
			const encrypted = await origKm.exportAllKeys("pass");

			// import same keys twice
			await km.importAllKeys(encrypted, "pass");
			const count = await km.importAllKeys(encrypted, "pass");
			expect(count).toBe(0);
		});
	});
});

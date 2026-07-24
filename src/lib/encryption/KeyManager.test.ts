import { describe, it, expect, beforeEach } from "vitest";
import { KeyManager } from "./KeyManager";
import type { KeyStorage, SecretEntry } from "./types";
import * as cryptoUtils from "./cryptoUtils";

function createMockStorage(): KeyStorage {
	const store = new Map<string, string>();
	return {
		getSecret(key: string) {
			return store.get(key);
		},
		setSecret(key: string, value: string) {
			store.set(key, value);
		},
	};
}

describe("KeyManager", () => {
	let km: KeyManager;
	let storage: KeyStorage;
	const createMockSettings = () => ({
		encryptionKeysSecretId: undefined,
	});

	beforeEach(() => {
		storage = createMockStorage();
		km = new KeyManager(storage, createMockSettings, async () => {});
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
			const info = await km.createKey("test");
			const json = await storage.getSecret(km.getKeysStorageId());
			expect(json).toBeTruthy();

			const parsed = JSON.parse(json!) as {
				version: number;
				keys: Record<string, SecretEntry>;
			};
			expect(parsed.version).toBe(1);
			expect(parsed.keys[info.fingerprint]).toBeDefined();
			expect(parsed.keys[info.fingerprint].name).toBe("test");
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
			await km.createKey("k1");
			await km.createKey("k2");

			const keys = await km.listKeys();
			expect(keys.length).toBe(2);
			const names = keys.map((k) => k.name);
			expect(names).toContain("k1");
			expect(names).toContain("k2");
		});

		it("listKeys returns keys sorted by priority descending", async () => {
			const k1 = await km.createKey("k1");
			const k2 = await km.createKey("k2");

			await km.setPrimaryKey(k2.fingerprint);

			const keys = await km.listKeys();
			expect(keys[0].fingerprint).toBe(k2.fingerprint);
			expect(keys[1].fingerprint).toBe(k1.fingerprint);
		});
	});

	describe("getPrimaryKey", () => {
		it("returns undefined when no keys exist", async () => {
			const pk = await km.getPrimaryKey();
			expect(pk).toBeUndefined();
		});

		it("returns the key with highest priority", async () => {
			await km.createKey("k1");
			const k2 = await km.createKey("k2");

			await km.setPrimaryKey(k2.fingerprint);

			const pk = await km.getPrimaryKey();
			expect(pk?.fingerprint).toBe(k2.fingerprint);
		});
	});

	describe("setPrimaryKey", () => {
		it("setPrimaryKey promotes a key to highest priority", async () => {
			const k1 = await km.createKey("k1");
			await km.createKey("k2");

			await km.setPrimaryKey(k1.fingerprint);

			const pk = await km.getPrimaryKey();
			expect(pk?.fingerprint).toBe(k1.fingerprint);
			expect(pk?.name).toBe("k1");
		});

		it("setPrimaryKey throws for nonexistent key", async () => {
			await expect(km.setPrimaryKey("nonexistent")).rejects.toThrow(
				"Key nonexistent not found",
			);
		});
	});

	describe("getKey / getKeyForEncrypt", () => {
		it("returns CryptoKey for decrypt", async () => {
			const info = await km.createKey("decrypt-test");
			const key = await km.getKey(info.fingerprint);

			expect(key).toBeDefined();
			expect(key?.algorithm.name).toBe("AES-GCM");
			expect(key?.usages).toEqual(["decrypt"]);
		});

		it("returns CryptoKey for encrypt with encrypt+decrypt usages", async () => {
			const info = await km.createKey("encrypt-test");
			const key = await km.getKeyForEncrypt(info.fingerprint);

			expect(key).toBeDefined();
			expect(key?.algorithm.name).toBe("AES-GCM");
			expect(key?.usages).toContain("encrypt");
			expect(key?.usages).toContain("decrypt");
		});

		it("returns undefined for unknown fingerprint", async () => {
			const key = await km.getKey("unknown-fp");
			expect(key).toBeUndefined();
		});
	});

	describe("deleteKey", () => {
		it("removes key from listKeys but keeps in listDeletedKeys", async () => {
			const info = await km.createKey("to-delete");
			await km.deleteKey(info.fingerprint);

			const activeKeys = await km.listKeys();
			expect(
				activeKeys.find((k) => k.fingerprint === info.fingerprint),
			).toBeUndefined();

			const deletedKeys = await km.listDeletedKeys();
			expect(
				deletedKeys.find((k) => k.fingerprint === info.fingerprint),
			).toBeDefined();
		});
	});

	describe("renameKey", () => {
		it("renames an existing key", async () => {
			const info = await km.createKey("old-name");
			await km.renameKey(info.fingerprint, "new-name");

			const keys = await km.listKeys();
			const found = keys.find((k) => k.fingerprint === info.fingerprint);
			expect(found?.name).toBe("new-name");
		});

		it("throws for nonexistent key", async () => {
			await expect(
				km.renameKey("nonexistent", "new-name"),
			).rejects.toThrow("Key nonexistent not found");
		});
	});

	describe("exportAllKeys / importAllKeys", () => {
		it("exports all keys encrypted with passphrase", async () => {
			await km.createKey("k1");
			await km.createKey("k2");

			const encrypted = await km.exportAllKeys("backup-pass");
			expect(encrypted).toBeTruthy();

			const plaintext = await cryptoUtils.decryptWithPassphrase(
				encrypted,
				"backup-pass",
			);
			const entries = JSON.parse(plaintext) as Array<{
				fingerprint: string;
				name: string;
			}>;

			expect(entries.length).toBe(2);
		});

		it("imports keys from backup", async () => {
			await km.createKey("k1");
			await km.createKey("k2");
			const backup = await km.exportAllKeys("backup-pass");

			const km2 = new KeyManager(
				createMockStorage(),
				createMockSettings,
				async () => {},
			);
			const count = await km2.importAllKeys(backup, "backup-pass");

			expect(count).toBe(2);
			const keys = await km2.listKeys();
			expect(keys.length).toBe(2);
		});

		it("reuses existing keys on import (skips duplicates)", async () => {
			await km.createKey("k1");
			const backup = await km.exportAllKeys("backup-pass");

			const count = await km.importAllKeys(backup, "backup-pass");
			expect(count).toBe(0);
		});
	});
});

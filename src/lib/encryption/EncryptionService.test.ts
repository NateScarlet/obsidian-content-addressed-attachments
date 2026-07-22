import { describe, it, expect, beforeEach } from "vitest";
import { EncryptionService } from "./EncryptionService";
import { KeyManager } from "./KeyManager";
import { ENCRYPTED_FORMAT, type KeyStorage } from "./types";

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

describe("EncryptionService", () => {
	let es: EncryptionService;
	let km: KeyManager;

	beforeEach(() => {
		km = new KeyManager(createMockStorage());
		es = new EncryptionService(km);
	});

	describe("isAvailable", () => {
		it("delegates to keyManager", () => {
			expect(es.isAvailable).toBe(true);
		});
	});

	describe("resolveKeyForNotePath", () => {
		it("returns undefined if no rules match", async () => {
			const key = await km.createKey("primary");
			const service = new EncryptionService(km, () => ({
				encryptPathRules: [
					{ pattern: "Secret/**", keyFingerprint: key.fingerprint },
				],
				maxBlobSize: 20 * 1024 * 1024,
			}));
			expect(
				await service.resolveKeyForNotePath("Public/note.md"),
			).toBeUndefined();
		});

		it("returns matching key fingerprint if rule matches", async () => {
			const key = await km.createKey("primary");
			const service = new EncryptionService(km, () => ({
				encryptPathRules: [
					{ pattern: "Secret/**", keyFingerprint: key.fingerprint },
				],
				maxBlobSize: 20 * 1024 * 1024,
			}));
			expect(await service.resolveKeyForNotePath("Secret/note.md")).toBe(
				key.fingerprint,
			);
		});

		it("falls back to primary key if rule keyFingerprint is empty", async () => {
			const key = await km.createKey("primary");
			const service = new EncryptionService(km, () => ({
				encryptPathRules: [
					{ pattern: "Secret/**", keyFingerprint: "" },
				],
				maxBlobSize: 20 * 1024 * 1024,
			}));
			expect(await service.resolveKeyForNotePath("Secret/note.md")).toBe(
				key.fingerprint,
			);
		});
	});

	describe("encryptFile", () => {
		it("produces encrypted file with correct type and content", async () => {
			const keyInfo = await km.createKey("test");
			const file = new File(["hello world"], "test.txt", {
				type: "text/plain",
			});

			const { encryptedFile, fingerprint } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);

			expect(fingerprint).toBe(keyInfo.fingerprint);
			expect(encryptedFile.type).toBe(ENCRYPTED_FORMAT);
			expect(encryptedFile.name).toBe("test.txt");
		});

		it("throws when key does not exist", async () => {
			const file = new File(["data"], "test.txt", { type: "text/plain" });
			await expect(
				es.encryptFile("nonexistent-fingerprint", file),
			).rejects.toThrow("not found");
		});

		it("produces different output for same content with different keys", async () => {
			const k1 = await km.createKey("key1");
			const k2 = await km.createKey("key2");
			const file = new File(["same"], "a.txt", { type: "text/plain" });

			const { encryptedFile: ef1 } = await es.encryptFile(
				k1.fingerprint,
				file,
			);
			const { encryptedFile: ef2 } = await es.encryptFile(
				k2.fingerprint,
				file,
			);

			const buf1 = await ef1.arrayBuffer();
			const buf2 = await ef2.arrayBuffer();
			expect(Buffer.from(buf1).equals(Buffer.from(buf2))).toBe(false);
		});
	});

	describe("decryptFile", () => {
		it("decrypts an encrypted file back to original", async () => {
			const keyInfo = await km.createKey("roundtrip");
			const originalContent = "Secret message";
			const file = new File([originalContent], "secret.txt", {
				type: "text/plain",
			});

			const { encryptedFile } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);
			const encryptedData = await encryptedFile.arrayBuffer();

			const result = await es.decryptFile(encryptedData);
			expect(result).toBeDefined();
			expect(result!.mimeType).toBe("text/plain");
			const decryptedText = new TextDecoder().decode(result!.data);
			expect(decryptedText).toBe(originalContent);
		});

		it("returns undefined for non-encrypted data", async () => {
			const result = await es.decryptFile(new ArrayBuffer(10));
			expect(result).toBeUndefined();
		});

		it("throws when decryption key is deleted", async () => {
			const keyInfo = await km.createKey("disappear");
			const file = new File(["gone"], "lost.txt", { type: "text/plain" });
			const { encryptedFile } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);
			const encryptedData = await encryptedFile.arrayBuffer();

			await km.deleteKey(keyInfo.fingerprint);

			await expect(es.decryptFile(encryptedData)).rejects.toThrow(
				"not found",
			);
		});
	});

	describe("createBlobURL", () => {
		it("creates a blob URL for encrypted file", async () => {
			const keyInfo = await km.createKey("blob-test");
			const file = new File(["blob content"], "b.txt", {
				type: "text/plain",
			});
			const { encryptedFile } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);
			const encryptedData = await encryptedFile.arrayBuffer();

			const url = await es.createBlobURL(encryptedData);
			expect(url).toBeTruthy();
			expect(url).toMatch(/^blob:/);

			const decrypted = await es.decryptFile(encryptedData);
			const text = new TextDecoder().decode(decrypted?.data);
			expect(text).toBe("blob content");
		});
	});

	describe("static isEncryptedFormat", () => {
		it("returns true for encrypted format string", () => {
			expect(EncryptionService.isEncryptedFormat(ENCRYPTED_FORMAT)).toBe(
				true,
			);
		});

		it("returns false for other formats", () => {
			expect(EncryptionService.isEncryptedFormat("text/plain")).toBe(
				false,
			);
			expect(EncryptionService.isEncryptedFormat("")).toBe(false);
		});
	});

	describe("maxBlobSize", () => {
		it("returns default max blob size", () => {
			expect(es.maxBlobSize).toBe(20 * 1024 * 1024);
		});
	});

	describe("key management delegation", () => {
		it("delegates createKey, listKeys, renameKey, exportKey, deleteKey, exportAllKeys, importAllKeys", async () => {
			const k1 = await es.createKey("key1");
			expect(k1.name).toBe("key1");

			let keys = await es.listKeys();
			expect(keys).toHaveLength(1);

			await es.renameKey(k1.fingerprint, "renamed-key");
			keys = await es.listKeys();
			expect(keys[0].name).toBe("renamed-key");

			const exported = await es.exportKey(k1.fingerprint);
			expect(exported).toBeTruthy();

			const backup = await es.exportAllKeys("pass123");
			expect(backup).toBeTruthy();

			await es.deleteKey(k1.fingerprint);
			expect(await es.listKeys()).toHaveLength(0);

			const importedCount = await es.importAllKeys(backup, "pass123");
			expect(importedCount).toBe(1);

			await es.setPrimaryKey(k1.fingerprint);
			keys = await es.listKeys();
			expect(keys[0].fingerprint).toBe(k1.fingerprint);
		});
	});
});

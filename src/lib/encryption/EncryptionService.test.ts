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
	};
}

function createMockSettings(): { encryptionKeysSecretId?: string } {
	return {};
}

describe("EncryptionService", () => {
	let es: EncryptionService;
	let km: KeyManager;

	beforeEach(() => {
		km = new KeyManager(
			createMockStorage(),
			createMockSettings,
			async () => {},
		);
		es = new EncryptionService(km);
	});

	describe("isAvailable", () => {
		it("delegates to keyManager", () => {
			expect(es.isAvailable).toBe(true);
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

		it("returns same file if already encrypted with the same key", async () => {
			const k1 = await km.createKey("key1");
			const file = new File(["same"], "a.txt", { type: "text/plain" });

			const { encryptedFile: ef1 } = await es.encryptFile(
				k1.fingerprint,
				file,
			);
			const { encryptedFile: ef2 } = await es.encryptFile(
				k1.fingerprint,
				ef1,
			);

			expect(ef2.name).toBe("a.txt");
			const buf1 = await ef1.arrayBuffer();
			const buf2 = await ef2.arrayBuffer();
			expect(Buffer.from(buf1).equals(Buffer.from(buf2))).toBe(true);
		});

		it("throws error if file is already encrypted with a different key", async () => {
			const k1 = await km.createKey("key1");
			const k2 = await km.createKey("key2");
			const file = new File(["same"], "a.txt", { type: "text/plain" });

			const { encryptedFile: ef1 } = await es.encryptFile(
				k1.fingerprint,
				file,
			);

			await expect(es.encryptFile(k2.fingerprint, ef1)).rejects.toThrow(
				"already encrypted",
			);
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

			const encryptedBuf = await encryptedFile.arrayBuffer();
			const decrypted = await es.decryptFile(encryptedBuf);

			expect(decrypted).toBeDefined();
			expect(decrypted!.mimeType).toBe("text/plain");
			const text = new TextDecoder().decode(decrypted!.data);
			expect(text).toBe(originalContent);
		});

		it("returns undefined when data is not encrypted format", async () => {
			const plainBuf = new TextEncoder().encode("not encrypted").buffer;
			const decrypted = await es.decryptFile(plainBuf);
			expect(decrypted).toBeUndefined();
		});

		it("throws when decryption fails due to missing key", async () => {
			const keyInfo = await km.createKey("to-be-deleted");
			const file = new File(["data"], "test.txt", { type: "text/plain" });
			const { encryptedFile } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);
			const encryptedBuf = await encryptedFile.arrayBuffer();

			await km.deleteKey(keyInfo.fingerprint);

			await expect(es.decryptFile(encryptedBuf)).rejects.toThrow(
				"not found",
			);
		});
	});

	describe("createBlobURL", () => {
		it("creates a blob URL for decrypted content", async () => {
			const keyInfo = await km.createKey("blob-test");
			const file = new File(["blob content"], "blob.txt", {
				type: "text/plain",
			});
			const { encryptedFile } = await es.encryptFile(
				keyInfo.fingerprint,
				file,
			);

			const encryptedBuf = await encryptedFile.arrayBuffer();
			const url = await es.createBlobURL(encryptedBuf);

			expect(url).toBeDefined();
			expect(url).toMatch(/^blob:/);

			// eslint-disable-next-line no-restricted-globals
			const res = await fetch(url!);
			const text = await res.text();
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
});

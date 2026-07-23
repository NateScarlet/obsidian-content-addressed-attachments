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

describe("EncryptionService", () => {
	let es: EncryptionService;
	let km: KeyManager;

	beforeEach(() => {
		km = new KeyManager(
			createMockStorage(),
			() => ({}),
			async () => {},
		);
		es = new EncryptionService(km);
	});

	describe("isAvailable", () => {
		it("delegates to keyManager", () => {
			expect(es.isAvailable).toBe(true);
		});
	});

	describe("resolveKeyForNotePath", () => {
		it("returns primary key when no rules match", async () => {
			const key = await km.createKey("primary");
			const service = new EncryptionService(km, () => [
				{ pattern: "Secret/**", keyFingerprint: key.fingerprint },
			]);
			expect(await service.resolveKeyForNotePath("Public/note.md")).toBe(
				key.fingerprint,
			);
		});

		it("returns matching key fingerprint if rule matches", async () => {
			const key = await km.createKey("secret-key");
			const service = new EncryptionService(km, () => [
				{ pattern: "Secret/**", keyFingerprint: key.fingerprint },
			]);
			expect(await service.resolveKeyForNotePath("Secret/note.md")).toBe(
				key.fingerprint,
			);
		});
	});

	describe("encrypt", () => {
		it("encrypts file with key resolved from notePath", async () => {
			const keyInfo = await km.createKey("test");
			const service = new EncryptionService(km, () => [
				{ pattern: "Secret/**", keyFingerprint: keyInfo.fingerprint },
			]);
			const file = new File(["hello world"], "test.txt", {
				type: "text/plain",
			});

			const res = await service.encrypt(file, {
				notePath: "Secret/doc.md",
			});

			expect(res).toBeDefined();
			expect(res!.fingerprint).toBe(keyInfo.fingerprint);
			expect(res!.encryptedFile.type).toBe(ENCRYPTED_FORMAT);
		});

		it("accepts raw ArrayBuffer as BinaryInput", async () => {
			const keyInfo = await km.createKey("buffer-key");
			const buffer = new TextEncoder().encode("buffer test").buffer;

			const res = await es.encrypt(buffer, {
				filename: "buf.txt",
				keyFingerprint: keyInfo.fingerprint,
			});

			expect(res).toBeDefined();
			expect(res!.encryptedFile.name).toBe("buf.txt");
			expect(res!.encryptedFile.type).toBe(ENCRYPTED_FORMAT);
		});

		it("returns same file if already encrypted with the same key", async () => {
			const keyInfo = await km.createKey("key1");
			const file = new File(["same"], "a.txt", { type: "text/plain" });

			const res1 = await es.encrypt(file, {
				keyFingerprint: keyInfo.fingerprint,
			});
			const res2 = await es.encrypt(res1!.encryptedFile, {
				keyFingerprint: keyInfo.fingerprint,
			});

			expect(res2!.encryptedFile.name).toBe("a.txt");
			const buf1 = await res1!.encryptedFile.arrayBuffer();
			const buf2 = await res2!.encryptedFile.arrayBuffer();
			expect(Buffer.from(buf1).equals(Buffer.from(buf2))).toBe(true);
		});
	});

	describe("decrypt", () => {
		it("decrypts an encrypted file back to original and offers toBlob & toBlobURL", async () => {
			const keyInfo = await km.createKey("roundtrip");
			const originalContent = "Secret message";
			const file = new File([originalContent], "secret.txt", {
				type: "text/plain",
			});

			const res = await es.encrypt(file, {
				keyFingerprint: keyInfo.fingerprint,
			});
			const encryptedBuf = await res!.encryptedFile.arrayBuffer();
			const decrypted = await es.decrypt(encryptedBuf);

			expect(decrypted).toBeDefined();
			expect(decrypted!.mimeType).toBe("text/plain");

			const blob = decrypted!.toBlob();
			expect(blob.type).toBe("text/plain");

			const url = decrypted!.toBlobURL();
			expect(url).toMatch(/^blob:/);

			// eslint-disable-next-line no-restricted-globals
			const r = await fetch(url);
			const text = await r.text();
			expect(text).toBe(originalContent);
		});
	});
});

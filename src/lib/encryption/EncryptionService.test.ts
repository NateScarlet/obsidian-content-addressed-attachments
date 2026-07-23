import { describe, it, expect, beforeEach } from "vitest";
import { EncryptionService } from "./EncryptionService";
import { EncryptPathPolicy } from "./EncryptPathPolicy";
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

	describe("inspect", () => {
		it("returns undefined for plaintext data without error", async () => {
			const buf = new TextEncoder().encode("plain text").buffer;
			const header = await es.inspect(buf);
			expect(header).toBeUndefined();
		});

		it("returns header metadata for encrypted data", async () => {
			const key = await km.createKey("test-key");
			const file = new File(["secret"], "a.txt", { type: "text/plain" });

			const encryptedFile = await es.ensureEncrypted(
				file,
				key.fingerprint,
			);
			const buf = await encryptedFile.arrayBuffer();

			const header = await es.inspect(buf);
			expect(header).toBeDefined();
			expect(header!.keyFingerprint).toBe(key.fingerprint);
			expect(header!.originalFormat).toBe("text/plain");
		});
	});

	describe("ensureEncrypted", () => {
		it("throws error if no key is available", async () => {
			const file = new File(["data"], "test.txt", { type: "text/plain" });
			await expect(es.ensureEncrypted(file)).rejects.toThrow(
				"No encryption key available",
			);
		});

		it("encrypts file directly returning File object when key is specified", async () => {
			const keyInfo = await km.createKey("test");
			const file = new File(["hello world"], "test.txt", {
				type: "text/plain",
			});

			const encryptedFile = await es.ensureEncrypted(
				file,
				keyInfo.fingerprint,
			);

			expect(encryptedFile).toBeDefined();
			expect(encryptedFile.name).toBe("test.txt");
			expect(encryptedFile.type).toBe(ENCRYPTED_FORMAT);
		});

		it("returns same file if already encrypted with the same key (idempotency)", async () => {
			const keyInfo = await km.createKey("key1");
			const file = new File(["same"], "a.txt", { type: "text/plain" });

			const encrypted1 = await es.ensureEncrypted(
				file,
				keyInfo.fingerprint,
			);
			const encrypted2 = await es.ensureEncrypted(
				encrypted1,
				keyInfo.fingerprint,
			);

			expect(encrypted2.name).toBe("a.txt");
			const buf1 = await encrypted1.arrayBuffer();
			const buf2 = await encrypted2.arrayBuffer();
			expect(Buffer.from(buf1).equals(Buffer.from(buf2))).toBe(true);
		});
	});

	describe("ensureDecrypted", () => {
		it("decrypts an encrypted file back to original with wasEncrypted = true", async () => {
			const keyInfo = await km.createKey("roundtrip");
			const originalContent = "Secret message";
			const file = new File([originalContent], "secret.txt", {
				type: "text/plain",
			});

			const encryptedFile = await es.ensureEncrypted(
				file,
				keyInfo.fingerprint,
			);
			const encryptedBuf = await encryptedFile.arrayBuffer();
			const decrypted = await es.ensureDecrypted(encryptedBuf);

			expect(decrypted).toBeDefined();
			expect(decrypted!.wasEncrypted).toBe(true);
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

		it("wraps plaintext as DecryptedResult with wasEncrypted = false", async () => {
			const plainBuf = new TextEncoder().encode("plain text").buffer;
			const decrypted = await es.ensureDecrypted(plainBuf);

			expect(decrypted).toBeDefined();
			expect(decrypted!.wasEncrypted).toBe(false);
			const text = new TextDecoder().decode(decrypted!.data);
			expect(text).toBe("plain text");
		});
	});
});

describe("EncryptPathPolicy", () => {
	let km: KeyManager;
	let es: EncryptionService;

	beforeEach(() => {
		km = new KeyManager(
			createMockStorage(),
			() => ({}),
			async () => {},
		);
		es = new EncryptionService(km);
	});

	it("resolves key fingerprint matching note path rules", async () => {
		const key = await km.createKey("path-key");
		const policy = new EncryptPathPolicy(km, es, () => [
			{ pattern: "Secret/**", keyFingerprint: key.fingerprint },
		]);

		expect(await policy.resolveKey("Secret/doc.md")).toBe(key.fingerprint);
		expect(await policy.resolveKey("Public/doc.md")).toBe(key.fingerprint); // Primary key fallback
	});

	it("encrypts file when note matches path rule", async () => {
		const keyInfo = await km.createKey("path-key");
		const policy = new EncryptPathPolicy(km, es, () => [
			{ pattern: "Secret/**", keyFingerprint: keyInfo.fingerprint },
		]);
		const file = new File(["hello world"], "test.txt", {
			type: "text/plain",
		});

		const encryptedFile = await policy.ensureEncrypted(
			file,
			"Secret/doc.md",
		);

		expect(encryptedFile).toBeDefined();
		expect(encryptedFile!.type).toBe(ENCRYPTED_FORMAT);
	});

	it("returns undefined if note path does not match any key/rule and no primary key", async () => {
		const policy = new EncryptPathPolicy(km, es, () => []);
		const file = new File(["hello world"], "test.txt", {
			type: "text/plain",
		});

		const res = await policy.ensureEncrypted(file, "Public/doc.md");
		expect(res).toBeUndefined();
	});
});

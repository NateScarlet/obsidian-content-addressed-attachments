import { describe, it, expect } from "vitest";
import {
	generateKey,
	encrypt,
	decrypt,
	parseHeader,
	isEncryptedData,
	encryptWithPassphrase,
	decryptWithPassphrase,
} from "#src/lib/encryption/CryptoService";

describe("CryptoService", () => {
	describe("generateKey", () => {
		it("creates AES-256-GCM key usable for encrypt and decrypt", async () => {
			const key = await generateKey();
			expect(key.algorithm).toMatchObject({
				name: "AES-GCM",
				length: 256,
			});
			expect(key.usages).toContain("encrypt");
			expect(key.usages).toContain("decrypt");
			expect(key.extractable).toBe(true);
		});
	});

	describe("encrypt + decrypt roundtrip", () => {
		it("encrypts and decrypts a known plaintext", async () => {
			const key = await generateKey();
			const plaintext = new TextEncoder().encode("Hello, World!").buffer;
			const { data, fingerprint } = await encrypt(key, plaintext, "text/plain");

			expect(fingerprint).toBeTruthy();
			expect(fingerprint.length).toBe(16); // 8 bytes as hex
			expect(data.byteLength).toBeGreaterThan(plaintext.byteLength);

			const decrypted = await decrypt(key, data);
			const decryptedText = new TextDecoder().decode(decrypted);
			expect(decryptedText).toBe("Hello, World!");
		});

		it("survives roundtrip with binary data", async () => {
			const key = await generateKey();
			const binaryData = new Uint8Array([0, 1, 255, 128, 64, 32, 16, 8, 4, 2]).buffer;
			const { data } = await encrypt(key, binaryData, "application/octet-stream");

			const decrypted = await decrypt(key, data);
			const decryptedBytes = new Uint8Array(decrypted);
			expect(Array.from(decryptedBytes)).toEqual([0, 1, 255, 128, 64, 32, 16, 8, 4, 2]);
		});

		it("produces different ciphertext for same plaintext with different keys", async () => {
			const key1 = await generateKey();
			const key2 = await generateKey();
			const plaintext = new TextEncoder().encode("same data").buffer;

			const { data: data1, fingerprint: fp1 } = await encrypt(key1, plaintext, "text/plain");
			const { data: data2, fingerprint: fp2 } = await encrypt(key2, plaintext, "text/plain");

			expect(fp1).not.toBe(fp2);
			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(false);
		});

		it("preserves original format through header", async () => {
			const key = await generateKey();
			const plaintext = new TextEncoder().encode("test").buffer;
			const { data } = await encrypt(key, plaintext, "image/png");

			const header = parseHeader(data);
			expect(header.originalFormat).toBe("image/png");
		});
	});

	describe("parseHeader", () => {
		it("extracts key fingerprint, IV, authTag, and format", async () => {
			const key = await generateKey();
			const plaintext = new TextEncoder().encode("test").buffer;
			const { data, fingerprint } = await encrypt(key, plaintext, "application/pdf");

			const header = parseHeader(data);
			expect(header.keyFingerprint).toBe(fingerprint);
			expect(header.iv.length).toBe(12);
			expect(header.authTag.length).toBe(16);
			expect(header.originalFormat).toBe("application/pdf");
		});

		it("throws on bad magic", async () => {
			const bad = new Uint8Array([0, 0, 0, 0, 0, 1]);
			expect(() => parseHeader(bad.buffer)).toThrow("bad magic");
		});

		it("throws on unsupported version", async () => {
			const bad = new Uint8Array([0x43, 0x45, 0x4e, 0x43, 0xff, 0xff]);
			expect(() => parseHeader(bad.buffer)).toThrow("Unsupported");
		});
	});

	describe("isEncryptedData", () => {
		it("returns true for valid encrypted data", async () => {
			const key = await generateKey();
			const { data } = await encrypt(key, new ArrayBuffer(0), "text/plain");
			expect(isEncryptedData(data)).toBe(true);
		});

		it("returns false for random data", () => {
			expect(isEncryptedData(new Uint8Array(4).buffer)).toBe(false);
			expect(isEncryptedData(new ArrayBuffer(0))).toBe(false);
		});

		it("returns false for data too short even with matching magic", () => {
			const bytes = new Uint8Array([0x43, 0x45, 0x4e, 0x43, 0x00]);
			expect(isEncryptedData(bytes.buffer)).toBe(false);
		});

		it("returns false for too-short data", () => {
			expect(isEncryptedData(new Uint8Array([0x43, 0x45, 0x4e]).buffer)).toBe(false);
		});
	});

	describe("decrypt with wrong key", () => {
		it("rejects decryption with wrong key", async () => {
			const key1 = await generateKey();
			const key2 = await generateKey();
			const plaintext = new TextEncoder().encode("secret").buffer;
			const { data } = await encrypt(key1, plaintext, "text/plain");

			await expect(decrypt(key2, data)).rejects.toThrow();
		});
	});

	describe("encryptWithPassphrase / decryptWithPassphrase", () => {
		it("roundtrips data with passphrase", async () => {
			const original = JSON.stringify({ foo: "bar" });
			const encrypted = await encryptWithPassphrase(original, "my-passphrase");
			expect(encrypted).toBeTruthy();

			const parsed = JSON.parse(encrypted);
			expect(parsed.salt).toBeTruthy();
			expect(parsed.iv).toBeTruthy();
			expect(parsed.data).toBeTruthy();

			const decrypted = await decryptWithPassphrase(encrypted, "my-passphrase");
			expect(decrypted).toBe(original);
		});

		it("rejects wrong passphrase", async () => {
			const original = "secret data";
			const encrypted = await encryptWithPassphrase(original, "correct");
			await expect(decryptWithPassphrase(encrypted, "wrong")).rejects.toThrow();
		});

		it("produces different ciphertext for same data with same passphrase", async () => {
			const data = "same data";
			const e1 = await encryptWithPassphrase(data, "pass");
			const e2 = await encryptWithPassphrase(data, "pass");
			// Different salt/IV ensures different output
			expect(e1).not.toBe(e2);
		});
	});
});

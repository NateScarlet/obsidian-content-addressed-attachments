import { describe, it, expect } from "vitest";
import * as cryptoUtils from "./cryptoUtils";

describe("CryptoService pure functions", () => {
	describe("generateKey", () => {
		it("creates AES-256-GCM key usable for encrypt and decrypt", async () => {
			const key = await cryptoUtils.generateKey();
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
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode("Hello, World!").buffer;
			const data = await cryptoUtils.encrypt(
				key,
				"1234567812345678",
				plaintext,
				"text/plain",
			);

			expect(data.byteLength).toBeGreaterThan(plaintext.byteLength);

			const { plaintext: decrypted } = await cryptoUtils.decrypt(
				() => key,
				data,
			);
			const decryptedText = new TextDecoder().decode(decrypted);
			expect(decryptedText).toBe("Hello, World!");
		});

		it("survives roundtrip with binary data", async () => {
			const key = await cryptoUtils.generateKey();
			const binaryData = new Uint8Array([
				0, 1, 255, 128, 64, 32, 16, 8, 4, 2,
			]).buffer;
			const data = await cryptoUtils.encrypt(
				key,
				"1234567812345678",
				binaryData,
				"application/octet-stream",
			);

			const { plaintext: decrypted } = await cryptoUtils.decrypt(
				() => key,
				data,
			);
			const decryptedBytes = new Uint8Array(decrypted);
			expect(Array.from(decryptedBytes)).toEqual([
				0, 1, 255, 128, 64, 32, 16, 8, 4, 2,
			]);
		});

		it("preserves original format in header", async () => {
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode("img").buffer;
			const data = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/png",
			);

			const { header } = await cryptoUtils.decrypt(() => key, data);
			expect(header.originalFormat).toBe("image/png");
			expect(header.keyFingerprint).toBe("fp1");
		});

		it("rejects decryption if header metadata (originalFormat) is tampered with (AAD verification failure)", async () => {
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode("tamper test").buffer;
			const encrypted = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/png",
			);

			// 找到 format 字符串在 Header 中的位置并篡改它
			const bytes = new Uint8Array(encrypted);
			const fmtString = "image/png";
			const fmtPos =
				bytes.length - plaintext.byteLength - fmtString.length;
			const tampered = new Uint8Array(encrypted.slice(0));
			tampered[fmtPos] = "t".charCodeAt(0); // 将 "image/png" 改为 "tmage/png"

			// AAD 校验应捕获篡改并抛出解密异常
			await expect(
				cryptoUtils.decrypt(() => key, tampered.buffer),
			).rejects.toThrow();
		});

		it("produces identical ciphertext for identical plaintext, key, and AAD (deterministic CAS encryption)", async () => {
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode(
				"identical content",
			).buffer;
			const data1 = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/png",
			);
			const data2 = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/png",
			);

			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(true);
		});

		it("produces different ciphertext and IV when same plaintext is encrypted with different AAD metadata", async () => {
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode(
				"identical content",
			).buffer;
			const data1 = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/png",
			);
			const data2 = await cryptoUtils.encrypt(
				key,
				"fp1",
				plaintext,
				"image/jpeg",
			);

			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(false);
		});

		it("throws when key is missing from resolver", async () => {
			const key = await cryptoUtils.generateKey();
			const plaintext = new TextEncoder().encode("test").buffer;
			const data = await cryptoUtils.encrypt(
				key,
				"fp-missing",
				plaintext,
				"text/plain",
			);

			await expect(
				cryptoUtils.decrypt(() => undefined, data),
			).rejects.toThrow("Decryption key fp-missing not found");
		});
	});

	describe("importKeyRaw & exportKeyRaw", () => {
		it("roundtrips key export and import", async () => {
			const key = await cryptoUtils.generateKey();
			const raw = await cryptoUtils.exportKeyRaw(key);
			expect(raw.byteLength).toBe(32);

			const imported = await cryptoUtils.importKeyRaw(raw);
			expect(imported.algorithm.name).toBe("AES-GCM");

			const importedEncrypt = await cryptoUtils.importKeyRawEncrypt(raw);
			const plaintext = new TextEncoder().encode("roundtrip").buffer;
			const encrypted = await cryptoUtils.encrypt(
				importedEncrypt,
				"fp",
				plaintext,
				"text/plain",
			);
			const { plaintext: decrypted } = await cryptoUtils.decrypt(
				() => imported,
				encrypted,
			);
			expect(new TextDecoder().decode(decrypted)).toBe("roundtrip");
		});
	});

	describe("computeFingerprint", () => {
		it("produces a 16-character hex string (64-bit fingerprint)", async () => {
			const key = await cryptoUtils.generateKey();
			const raw = await cryptoUtils.exportKeyRaw(key);
			const fp = await cryptoUtils.computeFingerprint(raw);
			expect(fp).toMatch(/^[0-9a-f]{16}$/);
		});

		it("produces identical fingerprint for identical raw bytes", async () => {
			const bytes = new Uint8Array(32).fill(42);
			const fp1 = await cryptoUtils.computeFingerprint(bytes);
			const fp2 = await cryptoUtils.computeFingerprint(bytes);
			expect(fp1).toBe(fp2);
		});
	});

	describe("encryptWithPassphrase & decryptWithPassphrase", () => {
		it("roundtrips data with passphrase", async () => {
			const json = await cryptoUtils.encryptWithPassphrase(
				"my-secret-key-data",
				"correct-horse-battery-staple",
			);
			const decrypted = await cryptoUtils.decryptWithPassphrase(
				json,
				"correct-horse-battery-staple",
			);
			expect(decrypted).toBe("my-secret-key-data");
		});

		it("rejects wrong passphrase", async () => {
			const json = await cryptoUtils.encryptWithPassphrase(
				"my-secret-key-data",
				"correct-passphrase",
			);
			await expect(
				cryptoUtils.decryptWithPassphrase(json, "wrong-passphrase"),
			).rejects.toThrow();
		});

		it("produces different ciphertext for same data with same passphrase", async () => {
			const json1 = await cryptoUtils.encryptWithPassphrase(
				"data",
				"pass",
			);
			const json2 = await cryptoUtils.encryptWithPassphrase(
				"data",
				"pass",
			);
			expect(json1).not.toEqual(json2);
		});

		it("rejects empty passphrase on encrypt and decrypt", async () => {
			await expect(
				cryptoUtils.encryptWithPassphrase("data", ""),
			).rejects.toThrow("Passphrase cannot be empty");
			await expect(
				cryptoUtils.decryptWithPassphrase(
					'{"salt":"a","iv":"b","data":"c"}',
					"",
				),
			).rejects.toThrow("Passphrase cannot be empty");
		});

		it("rejects malformed or invalid JSON payload", async () => {
			await expect(
				cryptoUtils.decryptWithPassphrase("invalid-json", "pass"),
			).rejects.toThrow("Invalid encrypted JSON payload");
			await expect(
				cryptoUtils.decryptWithPassphrase("12345", "pass"),
			).rejects.toThrow("Invalid encrypted JSON object format");
			await expect(
				cryptoUtils.decryptWithPassphrase('{"salt": "abc"}', "pass"),
			).rejects.toThrow("Missing required encrypted payload fields");
		});

		it("rejects untrusted or unsafe PBKDF2 iterations", async () => {
			const validJson = await cryptoUtils.encryptWithPassphrase(
				"data",
				"pass",
			);
			const parsed = JSON.parse(validJson) as Record<string, unknown>;

			// iterations 太低
			const lowIter = JSON.stringify({ ...parsed, iterations: 1000 });
			await expect(
				cryptoUtils.decryptWithPassphrase(lowIter, "pass"),
			).rejects.toThrow("Invalid PBKDF2 iterations count");

			// iterations 超高防止 DoS
			const highIter = JSON.stringify({
				...parsed,
				iterations: 999_999_999,
			});
			await expect(
				cryptoUtils.decryptWithPassphrase(highIter, "pass"),
			).rejects.toThrow("Invalid PBKDF2 iterations count");
		});
	});
});

import { describe, it, expect, beforeEach } from "vitest";
import { CryptoService } from "./CryptoService";

describe("CryptoService", () => {
	let cs: CryptoService;

	beforeEach(() => {
		cs = new CryptoService();
	});

	describe("generateKey", () => {
		it("creates AES-256-GCM key usable for encrypt and decrypt", async () => {
			const key = await cs.generateKey();
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
			const key = await cs.generateKey();
			const plaintext = new TextEncoder().encode("Hello, World!").buffer;
			const data = await cs.encrypt(
				key,
				"1234567812345678",
				plaintext,
				"text/plain",
			);

			expect(data.byteLength).toBeGreaterThan(plaintext.byteLength);

			const { plaintext: decrypted } = await cs.decrypt(key, data);
			const decryptedText = new TextDecoder().decode(decrypted);
			expect(decryptedText).toBe("Hello, World!");
		});

		it("survives roundtrip with binary data", async () => {
			const key = await cs.generateKey();
			const binaryData = new Uint8Array([
				0, 1, 255, 128, 64, 32, 16, 8, 4, 2,
			]).buffer;
			const data = await cs.encrypt(
				key,
				"1234567812345678",
				binaryData,
				"application/octet-stream",
			);

			const { plaintext: decrypted } = await cs.decrypt(key, data);
			const decryptedBytes = new Uint8Array(decrypted);
			expect(Array.from(decryptedBytes)).toEqual([
				0, 1, 255, 128, 64, 32, 16, 8, 4, 2,
			]);
		});

		it("decrypts using keyResolver callback", async () => {
			const key = await cs.generateKey();
			const plaintext = new TextEncoder().encode("test callback").buffer;
			const data = await cs.encrypt(
				key,
				"my-key-fp-123456",
				plaintext,
				"text/plain",
			);

			const { plaintext: decrypted, header } = await cs.decrypt(
				(fp) => (fp === "my-key-fp-123456" ? key : undefined),
				data,
			);
			expect(header.keyFingerprint).toBe("my-key-fp-123456");
			expect(new TextDecoder().decode(decrypted)).toBe("test callback");
		});

		it("produces different ciphertext for same plaintext with different keys", async () => {
			const key1 = await cs.generateKey();
			const key2 = await cs.generateKey();
			const plaintext = new TextEncoder().encode("same data").buffer;

			const data1 = await cs.encrypt(
				key1,
				"fp11111111111111",
				plaintext,
				"text/plain",
			);
			const data2 = await cs.encrypt(
				key2,
				"fp22222222222222",
				plaintext,
				"text/plain",
			);

			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(false);
		});

		it("preserves original format through header", async () => {
			const key = await cs.generateKey();
			const plaintext = new TextEncoder().encode("test").buffer;
			const data = await cs.encrypt(
				key,
				"1234567812345678",
				plaintext,
				"image/png",
			);

			const header = cs.parseHeader(data);
			expect(header.originalFormat).toBe("image/png");
		});
	});

	describe("parseHeader", () => {
		it("extracts key fingerprint, IV, authTag, and format", async () => {
			const key = await cs.generateKey();
			const plaintext = new TextEncoder().encode("test").buffer;
			const data = await cs.encrypt(
				key,
				"1234567812345678",
				plaintext,
				"application/pdf",
			);

			const header = cs.parseHeader(data);
			expect(header.keyFingerprint).toBe("1234567812345678");
			expect(header.iv.length).toBe(12);
			expect(header.authTag.length).toBe(16);
			expect(header.originalFormat).toBe("application/pdf");
		});

		it("throws on bad magic", () => {
			const bad = new Uint8Array([0, 0, 0, 0, 0, 1]);
			expect(() => cs.parseHeader(bad.buffer)).toThrow("bad magic");
		});

		it("throws on unsupported version", () => {
			const bad = new Uint8Array([0x43, 0x45, 0x4e, 0x43, 0xff, 0xff]);
			expect(() => cs.parseHeader(bad.buffer)).toThrow("Unsupported");
		});
	});

	describe("isEncryptedData", () => {
		it("returns true for valid encrypted data", async () => {
			const key = await cs.generateKey();
			const data = await cs.encrypt(
				key,
				"1234567812345678",
				new ArrayBuffer(0),
				"text/plain",
			);
			expect(cs.isEncryptedData(data)).toBe(true);
		});

		it("returns false for random data", () => {
			expect(cs.isEncryptedData(new Uint8Array(4).buffer)).toBe(false);
			expect(cs.isEncryptedData(new ArrayBuffer(0))).toBe(false);
		});

		it("returns false for data too short even with matching magic", () => {
			const bytes = new Uint8Array([0x43, 0x45, 0x4e, 0x43, 0x00]);
			expect(cs.isEncryptedData(bytes.buffer)).toBe(false);
		});

		it("returns false for too-short data", () => {
			expect(
				cs.isEncryptedData(new Uint8Array([0x43, 0x45, 0x4e]).buffer),
			).toBe(false);
		});
	});

	describe("decrypt with wrong key", () => {
		it("rejects decryption with wrong key", async () => {
			const key1 = await cs.generateKey();
			const key2 = await cs.generateKey();
			const plaintext = new TextEncoder().encode("secret").buffer;
			const data = await cs.encrypt(
				key1,
				"1234567812345678",
				plaintext,
				"text/plain",
			);

			await expect(cs.decrypt(key2, data)).rejects.toThrow();
		});
	});

	describe("encryptWithPassphrase / decryptWithPassphrase", () => {
		it("roundtrips data with passphrase", async () => {
			const original = JSON.stringify({ foo: "bar" });
			const encrypted = await cs.encryptWithPassphrase(
				original,
				"my-passphrase",
			);
			expect(encrypted).toBeTruthy();

			const parsed = JSON.parse(encrypted) as {
				salt: string;
				iv: string;
				data: string;
			};
			expect(parsed.salt).toBeTruthy();
			expect(parsed.iv).toBeTruthy();
			expect(parsed.data).toBeTruthy();

			const decrypted = await cs.decryptWithPassphrase(
				encrypted,
				"my-passphrase",
			);
			expect(decrypted).toBe(original);
		});

		it("rejects wrong passphrase", async () => {
			const original = "secret data";
			const encrypted = await cs.encryptWithPassphrase(
				original,
				"correct",
			);
			await expect(
				cs.decryptWithPassphrase(encrypted, "wrong"),
			).rejects.toThrow();
		});

		it("produces different ciphertext for same data with same passphrase", async () => {
			const data = "same data";
			const e1 = await cs.encryptWithPassphrase(data, "pass");
			const e2 = await cs.encryptWithPassphrase(data, "pass");
			expect(e1).not.toBe(e2);
		});
	});
});

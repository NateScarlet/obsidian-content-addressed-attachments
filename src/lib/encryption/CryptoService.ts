import {
	HEADER_MAGIC,
	HEADER_VERSION,
	IV_LENGTH,
	AUTH_TAG_LENGTH,
	KEY_FINGERPRINT_BYTES,
	KEY_ALGORITHM,
	KEY_LENGTH,
	type EncryptedFileHeader,
} from "./types";

/** PBKDF2 迭代次数 */
const PBKDF2_ITERATIONS = 600000;
/** 口令加密盐值长度 */
const SALT_LENGTH = 32;

export class CryptoService {
	async computeFingerprint(keyData: Uint8Array): Promise<string> {
		const digestResult = await crypto.subtle.digest(
			"SHA-256",
			keyData.buffer.slice(
				keyData.byteOffset,
				keyData.byteOffset + keyData.byteLength,
			) as ArrayBuffer,
		);
		const sha256Bytes = new Uint8Array(digestResult);
		const fpBytes = sha256Bytes.slice(0, KEY_FINGERPRINT_BYTES);
		return Array.from(fpBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	async generateKey(): Promise<CryptoKey> {
		return crypto.subtle.generateKey(
			{
				name: KEY_ALGORITHM,
				length: KEY_LENGTH,
			},
			true,
			["encrypt", "decrypt"],
		);
	}

	async exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
		const raw = await crypto.subtle.exportKey("raw", key);
		return new Uint8Array(raw);
	}

	async importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
		return crypto.subtle.importKey(
			"raw",
			raw.buffer as ArrayBuffer,
			{ name: KEY_ALGORITHM, length: KEY_LENGTH },
			false,
			["decrypt"],
		);
	}

	async importKeyRawEncrypt(raw: Uint8Array): Promise<CryptoKey> {
		return crypto.subtle.importKey(
			"raw",
			raw.buffer as ArrayBuffer,
			{ name: KEY_ALGORITHM, length: KEY_LENGTH },
			true,
			["encrypt", "decrypt"],
		);
	}

	/** 加密原始数据，返回完整的加密文件内容（含头） */
	async encrypt(
		key: CryptoKey,
		fingerprint: string,
		plaintext: ArrayBuffer,
		originalFormat: string,
	): Promise<ArrayBuffer> {
		const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

		const encrypted = await crypto.subtle.encrypt(
			{
				name: KEY_ALGORITHM,
				iv: iv.buffer.slice(
					iv.byteOffset,
					iv.byteOffset + iv.byteLength,
				),
				tagLength: AUTH_TAG_LENGTH * 8,
			},
			key,
			plaintext,
		);

		const ciphertextLen = encrypted.byteLength - AUTH_TAG_LENGTH;
		const ciphertext = new Uint8Array(encrypted, 0, ciphertextLen);
		const authTag = new Uint8Array(
			encrypted,
			ciphertextLen,
			AUTH_TAG_LENGTH,
		);

		const fmtBytes = new TextEncoder().encode(originalFormat);
		const fpBytes = new TextEncoder().encode(fingerprint);

		const headerSize =
			4 +
			2 +
			2 +
			fpBytes.byteLength +
			IV_LENGTH +
			AUTH_TAG_LENGTH +
			2 +
			fmtBytes.byteLength;
		const result = new Uint8Array(headerSize + ciphertext.byteLength);
		const dv = new DataView(
			result.buffer,
			result.byteOffset,
			result.byteLength,
		);
		let offset = 0;

		result.set(HEADER_MAGIC, offset);
		offset += 4;

		dv.setUint16(offset, HEADER_VERSION, true);
		offset += 2;

		dv.setUint16(offset, fpBytes.byteLength, true);
		offset += 2;

		result.set(fpBytes, offset);
		offset += fpBytes.byteLength;

		result.set(iv, offset);
		offset += IV_LENGTH;

		result.set(authTag, offset);
		offset += AUTH_TAG_LENGTH;

		dv.setUint16(offset, fmtBytes.byteLength, true);
		offset += 2;

		result.set(fmtBytes, offset);
		offset += fmtBytes.byteLength;

		result.set(ciphertext, offset);

		return result.buffer;
	}

	/** 从加密文件内容中解析头部 */
	parseHeader(encryptedData: ArrayBuffer): EncryptedFileHeader {
		const data = new Uint8Array(encryptedData);
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let offset = 0;

		for (let i = 0; i < 4; i++) {
			if (data[offset + i] !== HEADER_MAGIC[i]) {
				throw new Error("Invalid encrypted file: bad magic");
			}
		}
		offset += 4;

		const version = dv.getUint16(offset, true);
		offset += 2;
		if (version !== HEADER_VERSION) {
			throw new Error(`Unsupported encrypted file version: ${version}`);
		}

		const fpLen = dv.getUint16(offset, true);
		offset += 2;
		const fpBytes = data.slice(offset, offset + fpLen);
		offset += fpLen;
		const keyFingerprint = new TextDecoder().decode(fpBytes);

		const iv = data.slice(offset, offset + IV_LENGTH);
		offset += IV_LENGTH;

		const authTag = data.slice(offset, offset + AUTH_TAG_LENGTH);
		offset += AUTH_TAG_LENGTH;

		const fmtLen = dv.getUint16(offset, true);
		offset += 2;
		const fmtBytes = data.slice(offset, offset + fmtLen);
		offset += fmtLen;
		const originalFormat = new TextDecoder().decode(fmtBytes);

		return { keyFingerprint, iv, authTag, originalFormat };
	}

	/** 解密加密文件内容 */
	async decrypt(
		keyOrResolver:
			| CryptoKey
			| ((
					fingerprint: string,
			  ) => Promise<CryptoKey | undefined> | CryptoKey | undefined),
		encryptedData: ArrayBuffer,
	): Promise<{ plaintext: ArrayBuffer; header: EncryptedFileHeader }> {
		const header = this.parseHeader(encryptedData);

		const key =
			typeof keyOrResolver === "function"
				? await keyOrResolver(header.keyFingerprint)
				: keyOrResolver;

		if (!key) {
			throw new Error(
				`Decryption key ${header.keyFingerprint} not found. The key may have been deleted.`,
			);
		}

		const data = new Uint8Array(encryptedData);
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let offset = 0;

		offset += 6;
		const fpLen = dv.getUint16(offset, true);
		offset += 2 + fpLen;
		offset += IV_LENGTH;
		offset += AUTH_TAG_LENGTH;
		const fmtLen = dv.getUint16(offset, true);
		offset += 2 + fmtLen;

		const ciphertext = data.slice(offset);

		const combined = new Uint8Array(
			ciphertext.byteLength + AUTH_TAG_LENGTH,
		);
		combined.set(ciphertext, 0);
		combined.set(header.authTag, ciphertext.byteLength);

		const plaintext = await crypto.subtle.decrypt(
			{
				name: KEY_ALGORITHM,
				iv: header.iv.buffer.slice(
					header.iv.byteOffset,
					header.iv.byteOffset + header.iv.byteLength,
				) as ArrayBuffer,
				tagLength: AUTH_TAG_LENGTH * 8,
			},
			key,
			combined.buffer.slice(
				combined.byteOffset,
				combined.byteOffset + combined.byteLength,
			),
		);

		return { plaintext, header };
	}

	arrayBufferToBase64(buf: ArrayBuffer): string {
		const bytes = new Uint8Array(buf);
		let binary = "";
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	base64ToArrayBuffer(base64: string): ArrayBuffer {
		const binary = atob(base64);
		const buffer = new ArrayBuffer(binary.length);
		const bytes = new Uint8Array(buffer);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return buffer;
	}

	/** 用口令加密字符串，返回 JSON（salt/iv/data 均为 base64） */
	async encryptWithPassphrase(
		plaintext: string,
		passphrase: string,
	): Promise<string> {
		const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
		const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(passphrase),
			"PBKDF2",
			false,
			["deriveKey"],
		);

		const key = await crypto.subtle.deriveKey(
			{
				name: "PBKDF2",
				salt,
				iterations: PBKDF2_ITERATIONS,
				hash: "SHA-256",
			},
			keyMaterial,
			{ name: KEY_ALGORITHM, length: KEY_LENGTH },
			false,
			["encrypt"],
		);

		const encrypted = await crypto.subtle.encrypt(
			{ name: KEY_ALGORITHM, iv, tagLength: AUTH_TAG_LENGTH * 8 },
			key,
			new TextEncoder().encode(plaintext),
		);

		return JSON.stringify({
			algorithm: KEY_ALGORITHM,
			keyLength: KEY_LENGTH,
			kdf: "PBKDF2",
			kdfHash: "SHA-256",
			iterations: PBKDF2_ITERATIONS,
			salt: this.arrayBufferToBase64(salt.buffer),
			iv: this.arrayBufferToBase64(iv.buffer),
			data: this.arrayBufferToBase64(encrypted),
		});
	}

	/** 用口令解密由 encryptWithPassphrase 生成的 JSON */
	async decryptWithPassphrase(
		encryptedJson: string,
		passphrase: string,
	): Promise<string> {
		const parsed = JSON.parse(encryptedJson) as {
			algorithm?: string;
			keyLength?: number;
			kdf?: string;
			kdfHash?: string;
			iterations?: number;
			salt: string;
			iv: string;
			data: string;
		};

		// 向后兼容：旧格式没有算法参数，使用默认值
		const algorithm = parsed.algorithm ?? KEY_ALGORITHM;
		const keyLength = parsed.keyLength ?? KEY_LENGTH;
		const kdf = parsed.kdf ?? "PBKDF2";
		const kdfHash = parsed.kdfHash ?? "SHA-256";
		const iterations = parsed.iterations ?? PBKDF2_ITERATIONS;

		if (kdf !== "PBKDF2") {
			throw new Error(`Unsupported KDF: ${kdf}`);
		}
		if (algorithm !== KEY_ALGORITHM) {
			throw new Error(`Unsupported algorithm: ${algorithm}`);
		}

		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(passphrase),
			kdf,
			false,
			["deriveKey"],
		);

		const key = await crypto.subtle.deriveKey(
			{
				name: kdf,
				salt: this.base64ToArrayBuffer(parsed.salt),
				iterations,
				hash: kdfHash,
			},
			keyMaterial,
			{ name: algorithm, length: keyLength },
			false,
			["decrypt"],
		);

		const decrypted = await crypto.subtle.decrypt(
			{
				name: algorithm,
				iv: this.base64ToArrayBuffer(parsed.iv),
				tagLength: AUTH_TAG_LENGTH * 8,
			},
			key,
			this.base64ToArrayBuffer(parsed.data),
		);

		return new TextDecoder().decode(decrypted);
	}

	/** 检查数据是否为加密文件格式 */
	isEncryptedData(data: ArrayBuffer): boolean {
		if (data.byteLength < 4 + 2 + 2 + 1 + IV_LENGTH + AUTH_TAG_LENGTH + 2) {
			return false;
		}
		const bytes = new Uint8Array(data);
		for (let i = 0; i < 4; i++) {
			if (bytes[i] !== HEADER_MAGIC[i]) {
				return false;
			}
		}
		return true;
	}
}

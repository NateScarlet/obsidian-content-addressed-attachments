import type { EncryptedFileHeader } from "./types";
import {
	HEADER_MAGIC,
	HEADER_VERSION,
	IV_LENGTH,
	AUTH_TAG_LENGTH,
	parseHeader,
} from "./fileHeader";

/** AES-256-GCM 参数 */
const KEY_FINGERPRINT_BYTES = 8; // 64 bits
const KEY_ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;

/** PBKDF2 迭代次数 */
const PBKDF2_ITERATIONS = 1_500_000;
/** 口令加密盐值长度 */
const SALT_LENGTH = 32;

/** IV 派生密钥域隔离标签，无语义随机生成 */
const IV_DOMAIN_LABEL = new Uint8Array([
	0xbb, 0x37, 0xad, 0xc4, 0x48, 0x98, 0x98, 0x42, 0xb1, 0x7e, 0x97, 0x5e,
	0xb1, 0x77, 0xc6, 0xb7,
]);

/**
 * 构造 AEAD 附加认证数据 (Additional Authenticated Data, AAD)。
 * 包含文件头中除 IV 和 AuthTag 之外的所有明文元数据字段 (Magic, Version, Fingerprint, OriginalFormat)。
 * 将文件头绑定进 GCM Tag 认证签名中，彻底防止文件头元数据篡改攻击 (Header / Metadata Tampering Attack)。
 */
export function buildHeaderAAD(
	fingerprint: string,
	originalFormat: string,
): Uint8Array {
	const fpBytes = new TextEncoder().encode(fingerprint);
	const fmtBytes = new TextEncoder().encode(originalFormat);
	const aadSize = 4 + 2 + 2 + fpBytes.byteLength + 2 + fmtBytes.byteLength;
	const aad = new Uint8Array(aadSize);
	const dv = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
	let offset = 0;

	// Magic (4B)
	aad.set(HEADER_MAGIC, offset);
	offset += 4;

	// Version (2B)
	dv.setUint16(offset, HEADER_VERSION, true);
	offset += 2;

	// Fingerprint length (2B) + Fingerprint
	dv.setUint16(offset, fpBytes.byteLength, true);
	offset += 2;
	aad.set(fpBytes, offset);
	offset += fpBytes.byteLength;

	// Format length (2B) + Format
	dv.setUint16(offset, fmtBytes.byteLength, true);
	offset += 2;
	aad.set(fmtBytes, offset);

	return aad;
}

export async function computeFingerprint(keyData: Uint8Array): Promise<string> {
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

export async function generateKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey(
		{
			name: KEY_ALGORITHM,
			length: KEY_LENGTH,
		},
		true,
		["encrypt", "decrypt"],
	);
}

export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
	const raw = await crypto.subtle.exportKey("raw", key);
	return new Uint8Array(raw);
}

export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		raw.buffer as ArrayBuffer,
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		false,
		["decrypt"],
	);
}

export async function importKeyRawEncrypt(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		raw.buffer as ArrayBuffer,
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		true,
		["encrypt", "decrypt"],
	);
}

/**
 * 计算合成确定性 IV (Synthetic IV)，采用密钥域隔离 (Key Domain Separation)，
 * 将明文数据与 AAD (附加认证数据) 共同引入 HMAC 输入，
 * 遵循 RFC 5297 Synthetic IV 密码学规范，消除相同明文搭配不同 AAD 元数据导致的 GCM IV 碰撞隐患。
 */
async function computeSyntheticIV(
	key: CryptoKey,
	plaintext: ArrayBuffer,
	aad: Uint8Array,
): Promise<Uint8Array> {
	const rawKey = await exportKeyRaw(key);

	// 1. 密钥域隔离：使用主密钥派生专门算 IV 的子密钥 K_iv，绝不直接将主密钥作为 HMAC 密钥混用
	const masterHmacKey = await crypto.subtle.importKey(
		"raw",
		rawKey.buffer.slice(
			rawKey.byteOffset,
			rawKey.byteOffset + rawKey.byteLength,
		) as ArrayBuffer,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const ivKeyBytes = await crypto.subtle.sign(
		"HMAC",
		masterHmacKey,
		IV_DOMAIN_LABEL,
	);

	// 2. 将 AAD 字节与 Plaintext 字节拼接，作为 HMAC 输入 (RFC 5297 SIV)
	const plaintextBytes = new Uint8Array(plaintext);
	const hmacInput = new Uint8Array(
		aad.byteLength + plaintextBytes.byteLength,
	);
	hmacInput.set(aad, 0);
	hmacInput.set(plaintextBytes, aad.byteLength);

	// 3. 用专属 IV 子密钥签名，生成 32 字节摘要并截取前 12 字节 (96-bit)
	const ivHmacKey = await crypto.subtle.importKey(
		"raw",
		ivKeyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const fullTag = await crypto.subtle.sign("HMAC", ivHmacKey, hmacInput);
	return new Uint8Array(fullTag, 0, IV_LENGTH);
}

/** 加密原始数据，返回完整的加密二进制（含 CENC Header） */
export async function encrypt(
	key: CryptoKey,
	fingerprint: string,
	plaintext: ArrayBuffer,
	originalFormat: string,
): Promise<ArrayBuffer> {
	const aad = buildHeaderAAD(fingerprint, originalFormat);
	// 使用包含 AAD 与密钥域隔离的合成 IV (Synthetic IV)，实现 CAS 场景下的安全确定性加密
	const iv = await computeSyntheticIV(key, plaintext, aad);

	const encrypted = await crypto.subtle.encrypt(
		{
			name: KEY_ALGORITHM,
			iv: (iv.buffer as ArrayBuffer).slice(
				iv.byteOffset,
				iv.byteOffset + iv.byteLength,
			),
			additionalData: (aad.buffer as ArrayBuffer).slice(
				aad.byteOffset,
				aad.byteOffset + aad.byteLength,
			),
			tagLength: AUTH_TAG_LENGTH * 8,
		},
		key,
		plaintext,
	);

	const ciphertextLen = encrypted.byteLength - AUTH_TAG_LENGTH;
	const ciphertext = new Uint8Array(encrypted, 0, ciphertextLen);
	const authTag = new Uint8Array(encrypted, ciphertextLen, AUTH_TAG_LENGTH);

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

/** 解密加密二进制数据 */
export async function decrypt(
	keyResolver: (
		fingerprint: string,
	) => Promise<CryptoKey | undefined> | CryptoKey | undefined,
	encryptedData: ArrayBuffer,
): Promise<{ plaintext: ArrayBuffer; header: EncryptedFileHeader }> {
	const header = parseHeader(encryptedData);
	const key = await keyResolver(header.keyFingerprint);

	if (!key) {
		throw new Error(
			`Decryption key ${header.keyFingerprint} not found. The key may have been deleted.`,
		);
	}

	const aad = buildHeaderAAD(header.keyFingerprint, header.originalFormat);

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

	const combined = new Uint8Array(ciphertext.byteLength + AUTH_TAG_LENGTH);
	combined.set(ciphertext, 0);
	combined.set(header.authTag, ciphertext.byteLength);

	const plaintext = await crypto.subtle.decrypt(
		{
			name: KEY_ALGORITHM,
			iv: header.iv.buffer.slice(
				header.iv.byteOffset,
				header.iv.byteOffset + header.iv.byteLength,
			) as ArrayBuffer,
			additionalData: (aad.buffer as ArrayBuffer).slice(
				aad.byteOffset,
				aad.byteOffset + aad.byteLength,
			),
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

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return buffer;
}

/** 用口令加密字符串，返回 JSON（salt/iv/data 均为 base64） */
export async function encryptWithPassphrase(
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
		salt: arrayBufferToBase64(salt.buffer),
		iv: arrayBufferToBase64(iv.buffer),
		data: arrayBufferToBase64(encrypted),
	});
}

/** 用口令解密由 encryptWithPassphrase 生成的 JSON */
export async function decryptWithPassphrase(
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
			salt: base64ToArrayBuffer(parsed.salt),
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
			iv: base64ToArrayBuffer(parsed.iv),
			tagLength: AUTH_TAG_LENGTH * 8,
		},
		key,
		base64ToArrayBuffer(parsed.data),
	);

	return new TextDecoder().decode(decrypted);
}

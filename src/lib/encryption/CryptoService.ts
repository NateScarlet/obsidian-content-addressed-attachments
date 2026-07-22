import {
	HEADER_MAGIC,
	HEADER_VERSION,
	IV_LENGTH,
	AUTH_TAG_LENGTH,
	KEY_FINGERPRINT_BYTES,
	KEY_ALGORITHM,
	KEY_LENGTH,
	PBKDF2_ITERATIONS,
	SALT_LENGTH,
	type EncryptedFileHeader,
} from "./types";

async function computeFingerprint(keyData: Uint8Array): Promise<string> {
	const digestResult = await crypto.subtle.digest("SHA-256", keyData.buffer as ArrayBuffer);
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

export async function importKeyRawEncrypt(
	raw: Uint8Array,
): Promise<CryptoKey> {
	// Must be extractable so encrypt() can export it to compute the fingerprint
	return crypto.subtle.importKey(
		"raw",
		raw.buffer as ArrayBuffer,
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		true,
		["encrypt", "decrypt"],
	);
}

export { computeFingerprint };

/** 加密原始数据，返回完整的加密文件内容（含头） */
export async function encrypt(
	key: CryptoKey,
	plaintext: ArrayBuffer,
	originalFormat: string,
): Promise<{ data: ArrayBuffer; fingerprint: string }> {
	const keyData = await exportKeyRaw(key);
	const fingerprint = await computeFingerprint(keyData);

	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	const encrypted = await crypto.subtle.encrypt(
		{
			name: KEY_ALGORITHM,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			iv: iv as any,
			tagLength: AUTH_TAG_LENGTH * 8,
		},
		key,
		plaintext,
	);

	// AES-GCM returns: ciphertext || authTag (appended)
	const ciphertextLen = encrypted.byteLength - AUTH_TAG_LENGTH;
	const ciphertext = new Uint8Array(encrypted, 0, ciphertextLen);
	const authTag = new Uint8Array(encrypted, ciphertextLen, AUTH_TAG_LENGTH);

	const fmtBytes = new TextEncoder().encode(originalFormat);
	const fpBytes = new TextEncoder().encode(fingerprint);

	// Header layout:
	// [4 magic][2 version][2 fpLen][N fingerprint][12 IV][16 authTag][2 fmtLen][M format][remaining ciphertext]
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
	const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
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

	return { data: result.buffer, fingerprint };
}

/** 从加密文件内容中解析头部 */
export function parseHeader(encryptedData: ArrayBuffer): EncryptedFileHeader {
	const data = new Uint8Array(encryptedData);
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;

	// Magic
	for (let i = 0; i < 4; i++) {
		if (data[offset + i] !== HEADER_MAGIC[i]) {
			throw new Error("Invalid encrypted file: bad magic");
		}
	}
	offset += 4;

	// Version
	const version = dv.getUint16(offset, true);
	offset += 2;
	if (version !== HEADER_VERSION) {
		throw new Error(`Unsupported encrypted file version: ${version}`);
	}

	// Key fingerprint
	const fpLen = dv.getUint16(offset, true);
	offset += 2;
	const fpBytes = data.slice(offset, offset + fpLen);
	offset += fpLen;
	const keyFingerprint = new TextDecoder().decode(fpBytes);

	// IV
	const iv = data.slice(offset, offset + IV_LENGTH);
	offset += IV_LENGTH;

	// Auth tag
	const authTag = data.slice(offset, offset + AUTH_TAG_LENGTH);
	offset += AUTH_TAG_LENGTH;

	// Original format
	const fmtLen = dv.getUint16(offset, true);
	offset += 2;
	const fmtBytes = data.slice(offset, offset + fmtLen);
	offset += fmtLen;
	const originalFormat = new TextDecoder().decode(fmtBytes);

	return { keyFingerprint, iv, authTag, originalFormat };
}

/** 解密加密文件内容 */
export async function decrypt(
	key: CryptoKey,
	encryptedData: ArrayBuffer,
): Promise<ArrayBuffer> {
	const header = parseHeader(encryptedData);

	const data = new Uint8Array(encryptedData);
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;

	// Skip magic(4) + version(2)
	offset += 6;
	// Skip fpLen field(2) + fingerprint data
	const fpLen = dv.getUint16(offset, true);
	offset += 2 + fpLen;
	// Skip IV(12)
	offset += IV_LENGTH;
	// Skip authTag(16) — already extracted by parseHeader
	offset += AUTH_TAG_LENGTH;
	// Skip fmtLen field(2) + format string
	const fmtLen = dv.getUint16(offset, true);
	offset += 2 + fmtLen;

	// Now offset points at the raw ciphertext (without GCM auth tag)
	const ciphertext = data.slice(offset);

	// Reconstruct GCM input: ciphertext || authTag
	const combined = new Uint8Array(
		ciphertext.byteLength + AUTH_TAG_LENGTH,
	);
	combined.set(ciphertext, 0);
	combined.set(header.authTag, ciphertext.byteLength);

	// eslint-disable-next-line no-restricted-globals
	const plaintext = await crypto.subtle.decrypt(
		{
			name: KEY_ALGORITHM,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			iv: header.iv as any,
			tagLength: AUTH_TAG_LENGTH * 8,
		},
		key,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		combined as any,
	);

	return plaintext;
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
		salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
		iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
		data: arrayBufferToBase64(encrypted),
	});
}

/** 用口令解密由 encryptWithPassphrase 生成的 JSON */
export async function decryptWithPassphrase(
	encryptedJson: string,
	passphrase: string,
): Promise<string> {
	const { salt, iv, data } = JSON.parse(encryptedJson);

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
			salt: base64ToArrayBuffer(salt),
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		keyMaterial,
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		false,
		["decrypt"],
	);

	const decrypted = await crypto.subtle.decrypt(
		{ name: KEY_ALGORITHM, iv: base64ToArrayBuffer(iv), tagLength: AUTH_TAG_LENGTH * 8 },
		key,
		base64ToArrayBuffer(data),
	);

	return new TextDecoder().decode(decrypted);
}

/** 检查数据是否为加密文件格式 */
export function isEncryptedData(data: ArrayBuffer): boolean {
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

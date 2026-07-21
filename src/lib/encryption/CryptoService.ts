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
	return crypto.subtle.importKey(
		"raw",
		raw.buffer as ArrayBuffer,
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		false,
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
	let headerStart = 0;

	headerStart += 4;
	headerStart += 2;
	const fpLen = dv.getUint16(headerStart, true);
	headerStart += 2;
	headerStart += fpLen;
	headerStart += IV_LENGTH;

	const ciphertextWithTag = data.slice(headerStart);

	// Reconstruct the full encrypted payload (ciphertext + auth tag) as GCM expects it
	const combined = new Uint8Array(
		ciphertextWithTag.byteLength + AUTH_TAG_LENGTH,
	);
	combined.set(ciphertextWithTag, 0);
	combined.set(header.authTag, ciphertextWithTag.byteLength);

	// eslint-disable-next-line no-restricted-globals
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

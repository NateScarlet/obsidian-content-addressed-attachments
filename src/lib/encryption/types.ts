/** 加密文件格式标记 */
export const ENCRYPTED_FORMAT = "application/x.w1kxt3qz.encrypted";

/** 加密文件头幻数 "CENC" */
export const HEADER_MAGIC = new Uint8Array([0x43, 0x45, 0x4e, 0x43]);
export const HEADER_VERSION = 1;

/** AES-256-GCM 参数 */
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16; // 128 bits
export const KEY_FINGERPRINT_BYTES = 8; // 64 bits
export const KEY_ALGORITHM = "AES-GCM";
export const KEY_LENGTH = 256;

/** 加密密钥信息 */
export interface EncryptionKeyInfo {
	fingerprint: string;
	name: string;
	createdAt: Date;
}

/** 解密后的文件信息 */
export interface DecryptedFile {
	data: ArrayBuffer;
	mimeType: string;
}

/** 加密的 CAS 元数据 */
export interface EncryptedFileHeader {
	keyFingerprint: string;
	iv: Uint8Array;
	authTag: Uint8Array;
	originalFormat: string;
}

export const SECRET_STORAGE_KEY_PREFIX =
	"content-addressed-attachments/key/";

export const SECRET_STORAGE_META_KEY =
	"content-addressed-attachments/key-meta";

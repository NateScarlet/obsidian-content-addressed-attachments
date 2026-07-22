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

/** 口令加密导出参数 */
export const PBKDF2_ITERATIONS = 600000;
export const SALT_LENGTH = 32;

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

export const STORAGE_KEY_PREFIX = "content-addressed-attachments-";

/** 密钥持久化存储接口，用于依赖注入 */
export interface KeyStorage {
	getSecret(key: string): Promise<string | undefined>;
	setSecret(key: string, value: string): Promise<void>;
	listSecrets(): Promise<string[]>;
}

/** SecretStorage 中单条 entry 的结构 */
interface SecretEntry {
	key: string; // base64 编码的密钥材料
	name: string;
	createdAt: string; // ISO date
}

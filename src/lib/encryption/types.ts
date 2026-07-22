/** 加密文件格式标记 */
export const ENCRYPTED_FORMAT = "application/x.w1kxt3qz.encrypted";

/** 加密密钥信息 */
export interface EncryptionKeyInfo {
	fingerprint: string;
	name: string;
	createdAt: Date;
	priority: number;
	deletedAt?: Date;
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

/** 密钥持久化存储接口，用于依赖注入 */
export interface KeyStorage {
	getSecret(
		key: string,
	): string | null | undefined | Promise<string | null | undefined>;
	setSecret(key: string, value: string): void | Promise<void>;
}

/** 单条 entry 的结构 */
export interface SecretEntry {
	key: string; // base64 编码的密钥材料
	name?: string;
	createdAt: string; // ISO date
	priority?: number;
	deletedAt?: string; // ISO date, 标记软删除
}

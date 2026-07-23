export { ENCRYPTED_FORMAT } from "./constants";

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
	): Promise<string | undefined> | string | undefined | null;
	setSecret(key: string, value: string): Promise<void> | void;
}

/** 存储在 secretStorage 中的单条密钥记录 */
export interface SecretEntry {
	key: string; // base64 编码的 256 位密钥原始字节
	name?: string;
	createdAt: string; // ISO 8601
	priority?: number;
	deletedAt?: string; // ISO 8601，存在则表示已软删除
}

import type { EncryptedFileHeader } from "./types";

/**
 * 加密文件头魔数 "\xfdENC" (0xFD, 'E', 'N', 'C')
 * - 0xFD 具有非 ASCII / 非合法 UTF-8 文本开头特征，彻底排除纯文本误判；
 * - "ENC" 保持终端 hexdump 可读的加密文件特征。
 */
export const HEADER_MAGIC = new Uint8Array([0xfd, 0x45, 0x4e, 0x43]);
export const HEADER_VERSION = 1;

/** AES-256-GCM 参数 */
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16; // 128 bits

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

/** 从加密文件数据中解析头部信息 */
export function parseHeader(encryptedData: ArrayBuffer): EncryptedFileHeader {
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

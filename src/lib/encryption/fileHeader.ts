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
export const FINGERPRINT_BYTES = 8; // 64 bits 固定 Raw Binary 长度

/** 将 16 字符 Hex 字符串解析为 8 字节原生二进制 */
export function hexToBytes(hex: string): Uint8Array {
	if (hex.length !== 16) {
		throw new Error(`Invalid fingerprint hex length: ${hex.length}`);
	}
	const bytes = new Uint8Array(FINGERPRINT_BYTES);
	for (let i = 0; i < FINGERPRINT_BYTES; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/** 将 8 字节原生二进制格式化为 16 字符 Hex 字符串 */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

/** 检查数据是否为加密文件格式 */
export function isEncryptedData(data: ArrayBuffer): boolean {
	// 最小 Header 长度: 4(Magic) + 2(Version) + 8(FP) + 12(IV) + 16(Tag) + 2(FmtLen) = 44 字节
	if (data.byteLength < 44) {
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

	// 8 字节固定 Raw Binary 密钥指纹
	const fpBytes = data.slice(offset, offset + FINGERPRINT_BYTES);
	offset += FINGERPRINT_BYTES;
	const keyFingerprint = bytesToHex(fpBytes);

	const iv = data.slice(offset, offset + IV_LENGTH);
	offset += IV_LENGTH;

	const authTag = data.slice(offset, offset + AUTH_TAG_LENGTH);
	offset += AUTH_TAG_LENGTH;

	const fmtLen = dv.getUint16(offset, true);
	offset += 2;
	const fmtBytes = data.slice(offset, offset + fmtLen);
	offset += fmtLen;
	const originalFormat = new TextDecoder().decode(fmtBytes);

	return { keyFingerprint, iv, authTag, originalFormat, ciphertextOffset: offset };
}

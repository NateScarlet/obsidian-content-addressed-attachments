import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/**
 * 计算二进制数据的 CID（v1, raw codec, SHA-256）。
 */
export default async function computeCID(
	data: ArrayBuffer,
): Promise<string> {
	const digest = await sha256.digest(new Uint8Array(data));
	return CID.create(1, 0x55, digest).toString();
}
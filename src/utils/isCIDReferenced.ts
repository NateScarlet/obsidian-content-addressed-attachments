import type { CID } from "multiformats";
import type ReferenceManager from "#src/ReferenceManager";

/**
 * 引用判定：该 CID 是否仍被笔记引用。
 * 「引用计数 > 0 即被引用」这条判定规则集中于此，避免各调用方各写一遍。
 */
export default async function isCIDReferenced(
	referenceManager: ReferenceManager,
	cid: CID,
	signal?: AbortSignal,
): Promise<boolean> {
	return (await referenceManager.count(cid, 1, signal)) > 0;
}

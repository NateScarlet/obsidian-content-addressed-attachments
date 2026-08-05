import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type ReferenceManager from "#src/ReferenceManager";

/**
 * 如果 CID 不再被其他笔记引用，则将其移入回收站。
 * 调用方应在更新引用后再调用此函数，避免误删。
 */
export async function trashIfUnreferenced(
	cas: CAS,
	referenceManager: ReferenceManager,
	cid: CID,
): Promise<void> {
	const referencingFiles: string[] = [];
	for await (const path of referenceManager.findFilePath(cid, undefined)) {
		referencingFiles.push(path);
	}
	if (referencingFiles.length > 0) return;
	await cas.trash(cid);
}

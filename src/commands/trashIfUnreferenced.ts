import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type ReferenceManager from "#src/ReferenceManager";

/**
 * 如果 CID 不再被其他笔记引用，则将其移入回收站。
 */
export async function trashIfUnreferenced(
	cas: CAS,
	referenceManager: ReferenceManager,
	cid: CID,
	currentNotePath: string | undefined,
): Promise<void> {
	const referencingFiles: string[] = [];
	for await (const path of referenceManager.findFilePath(cid, undefined)) {
		if (path !== currentNotePath) {
			referencingFiles.push(path);
		}
	}
	if (referencingFiles.length > 0) return;
	await cas.trash(cid);
}

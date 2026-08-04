import { type App } from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type { URLResolver } from "#src/URLResolver";
import type ReferenceManager from "#src/ReferenceManager";
import IPFSLink from "#src/utils/IPFSLink";

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

/**
 * 加载链接对应的二进制内容。
 * 优先调用 cas.load(cid) 加载（当文件位于垃圾箱 .trash 中时，cas.load 会自动还原并校验文件），
 * 其次回退调用 urlResolver。
 */
export async function loadFileContent(
	app: App,
	cas: CAS,
	urlResolver: URLResolver,
	rawURL: string,
): Promise<ArrayBuffer | undefined> {
	const parsed = IPFSLink.parse(rawURL);
	if (parsed) {
		const match = await cas.load(parsed.cid);
		if (match?.normalizedPath) {
			return app.vault.adapter.readBinary(match.normalizedPath);
		}
	}
	const resolved = await urlResolver.resolveURL(rawURL);
	if (resolved?.path) {
		return app.vault.adapter.readBinary(resolved.path);
	}
}

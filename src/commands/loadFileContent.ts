import { type App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { URLResolver } from "#src/URLResolver";
import IPFSLink from "#src/utils/IPFSLink";

/**
 * 加载链接对应的二进制内容。
 * 优先调用 cas.load(cid) 加载（当文件位于垃圾箱 .trash 中时，cas.load 会自动还原并校验文件），
 * 其次回退调用 urlResolver。
 */
export default async function loadFileContent(
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

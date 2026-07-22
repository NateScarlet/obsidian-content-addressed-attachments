import type { App, TFile } from "obsidian";
import findIPFSLinks, { type IPFSLinkMatch } from "./findIPFSLinks";

export type LinkReplacer = (
	linkMatch: IPFSLinkMatch,
	linkText: string,
) => Promise<string | undefined> | string | undefined;

export class VaultLinkTransformer {
	constructor(private app: App) {}

	/**
	 * 转换单个笔记文件中的 IPFS 链接
	 * @returns 成功修改的链接数量
	 */
	async transformFile(file: TFile, replacer: LinkReplacer): Promise<number> {
		let content = await this.app.vault.read(file);
		const matches = Array.from(findIPFSLinks(content));
		let count = 0;

		// 倒序替换以保持文本 offset 有效
		for (let i = matches.length - 1; i >= 0; i--) {
			const match = matches[i];
			const linkText = content.slice(match.pos[0], match.pos[1]);
			try {
				const replacement = await replacer(match, linkText);
				if (replacement !== undefined && replacement !== linkText) {
					content =
						content.slice(0, match.pos[0]) +
						replacement +
						content.slice(match.pos[1]);
					count++;
				}
			} catch (err) {
				console.error(
					`Failed to transform link in ${file.path}:`,
					match,
					err,
				);
			}
		}

		if (count > 0) {
			await this.app.vault.modify(file, content);
		}
		return count;
	}
}

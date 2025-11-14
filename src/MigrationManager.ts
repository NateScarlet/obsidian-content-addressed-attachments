import { App, TFile, LinkCache, getLinkpath } from "obsidian";
import ContentAddressedAttachmentPlugin from "./main";
import { dirname, join } from "path-browserify";
import defineLocales from "./utils/defineLocales";

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		externalLink: "External link",
		alreadyIPFS: "Already IPFS link",
		cannotResolvePath: "Cannot resolve file path",
		excludedFile: "Excluded File",
		fileNotExist: "File does not exist",
		fileMigrationFailed: "File migration failed",
		skipNote: (path: string) => `Skipped note ${path}: no file links`,
		skipNoteNoMetadata: (path: string) =>
			`Skipped note ${path}: no metadata cache`,
		errorProcessingNote: (path: string, error: string) =>
			`Error processing note ${path}: ${error}`,
		errorProcessingLink: (link: string, error: string) =>
			`Error processing link ${link}: ${error}`,
		migratedLink: (oldLink: string, newLink: string) =>
			`Migrated link: ${oldLink} -> ${newLink}`,
		skippedLink: (link: string, reason: string) =>
			`Skipped link: ${link} (${reason})`,
		updatedNote: (path: string, count: number) =>
			`Updated note ${path}: migrated ${count} file links`,
		noMigrationNeeded: (path: string) =>
			`Skipped note ${path}: no file links to migrate`,
		noActiveNote: "No active note",
	},
	zh: {
		externalLink: "外部链接",
		alreadyIPFS: "已是IPFS链接",
		excludedFile: "排除的文件",
		cannotResolvePath: "无法解析文件路径",
		fileNotExist: "文件不存在",
		fileMigrationFailed: "文件迁移失败",
		skipNote: (path: string) => `跳过笔记 ${path}: 无文件链接`,
		skipNoteNoMetadata: (path: string) => `跳过笔记 ${path}: 无元数据缓存`,
		errorProcessingNote: (path: string, error: string) =>
			`错误处理笔记 ${path}: ${error}`,
		errorProcessingLink: (link: string, error: string) =>
			`错误处理链接 ${link}: ${error}`,
		migratedLink: (oldLink: string, newLink: string) =>
			`迁移链接: ${oldLink} -> ${newLink}`,
		skippedLink: (link: string, reason: string) =>
			`跳过链接: ${link} (${reason})`,
		updatedNote: (path: string, count: number) =>
			`已更新笔记 ${path}: 迁移了 ${count} 个文件链接`,
		noMigrationNeeded: (path: string) =>
			`跳过笔记 ${path}: 没有可迁移的文件链接`,
		noActiveNote: "没有活动的笔记",
	},
});
//#endregion

export interface MigrationResult {
	success: boolean;
	migrated: number;
	skipped: number;
	errors: number;
	details: string[];
}

export class MigrationManager {
	private app: App;

	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		this.app = plugin.app;
	}

	/**
	 * 迁移当前活动笔记中的文件
	 */
	async migrateCurrentNote(): Promise<MigrationResult> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			throw new Error(t("noActiveNote"));
		}

		return this.migrateNote(file);
	}

	/**
	 * 迁移所有笔记中的文件
	 */
	async migrateAllNotes(): Promise<MigrationResult> {
		const files = this.app.vault.getMarkdownFiles();
		const result: MigrationResult = {
			success: true,
			migrated: 0,
			skipped: 0,
			errors: 0,
			details: [],
		};

		for (const file of files) {
			try {
				const noteResult = await this.migrateNote(file);
				result.migrated += noteResult.migrated;
				result.skipped += noteResult.skipped;
				result.errors += noteResult.errors;
				result.details.push(...noteResult.details);
			} catch (error) {
				result.errors++;
				result.details.push(
					t("errorProcessingNote")(file.path, error.message),
				);
				result.success = false;
			}
		}

		return result;
	}

	/**
	 * 迁移单个笔记中的文件
	 */
	private async migrateNote(file: TFile): Promise<MigrationResult> {
		const result: MigrationResult = {
			success: true,
			migrated: 0,
			skipped: 0,
			errors: 0,
			details: [],
		};

		try {
			// 获取笔记的元数据缓存
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) {
				result.skipped++;
				result.details.push(t("skipNoteNoMetadata")(file.path));
				return result;
			}

			// 收集所有链接（包括嵌入文件）
			const links: LinkCache[] = [];
			if (cache.links) links.push(...cache.links);
			if (cache.embeds) links.push(...cache.embeds);

			if (links.length === 0) {
				result.skipped++;
				result.details.push(t("skipNote")(file.path));
				return result;
			}

			// 读取原始内容
			let content = await this.app.vault.read(file);
			let migratedCount = 0;

			// 从后往前处理链接，避免位置偏移
			const sortedLinks = [...links].sort(
				(a, b) => b.position.start.offset - a.position.start.offset,
			);

			for (const link of sortedLinks) {
				try {
					const migrationResult = await this.migrateLink(
						link,
						content,
						file.path,
					);
					if (migrationResult.success && migrationResult.newContent) {
						content = migrationResult.newContent;
						migratedCount++;
						result.details.push(
							t("migratedLink")(
								link.link,
								migrationResult.url || "",
							),
						);
					} else {
						result.skipped++;
						result.details.push(
							t("skippedLink")(
								link.link,
								migrationResult.reason || "",
							),
						);
					}
				} catch (error) {
					result.errors++;
					result.details.push(
						t("errorProcessingLink")(link.link, error.message),
					);
				}
			}

			if (migratedCount > 0) {
				await this.app.vault.modify(file, content);
				result.migrated = migratedCount;
				result.details.unshift(
					t("updatedNote")(file.path, migratedCount),
				);
			} else {
				result.skipped++;
				result.details.unshift(t("noMigrationNeeded")(file.path));
			}
		} catch (error) {
			result.success = false;
			result.errors++;
			result.details.push(
				t("errorProcessingNote")(file.path, error.message),
			);
		}

		return result;
	}

	/**
	 * 迁移单个链接
	 */
	private async migrateLink(
		link: LinkCache,
		content: string,
		notePath: string,
	): Promise<{
		success: boolean;
		newContent?: string;
		url?: string;
		reason?: string;
	}> {
		// 跳过外部链接和已经是 IPFS 的链接
		if (link.link.startsWith("http")) {
			return { success: false, reason: t("externalLink") };
		}

		if (link.link.startsWith("ipfs://")) {
			return { success: false, reason: t("alreadyIPFS") };
		}

		// 解析文件路径
		const file = this.app.metadataCache.getFirstLinkpathDest(
			link.link,
			notePath,
		);
		if (!file) {
			return { success: false, reason: t("cannotResolvePath") };
		}
		console.log(file.extension)
		switch (file.extension) {
			case "txt":
			case "md":
				return { success: false, reason: t("excludedFile") };
		}

		// 检查文件是否存在
		if (!file) {
			console.debug("文件不存在", { link, notePath });
			return { success: false, reason: t("fileNotExist") };
		}

		// 迁移文件到 IPFS
		const result = await this.migrateFile(file);
		if (!result.success) {
			return { success: false, reason: t("fileMigrationFailed") };
		}

		// 替换链接
		let newLinkText: string;
		let title = link.link || file.basename;
		if (link.displayText != title) {
			title += `|${link.displayText}`;
		}
		if (link.original.startsWith("!")) {
			// 图片链接
			newLinkText = `![${title}](${result.url})`;
		} else {
			newLinkText = `[${title}](${result.url})`;
		}

		const newContent =
			content.substring(0, link.position.start.offset) +
			newLinkText +
			content.substring(link.position.end.offset);

		return {
			success: true,
			newContent,
			url: result.url,
		};
	}

	/**
	 * 迁移单个文件到IPFS
	 */
	private async migrateFile(file: TFile): Promise<{
		success: boolean;
		url?: string;
		error?: string;
	}> {
		try {
			// 读取文件内容
			const arrayBuffer = await this.app.vault.readBinary(file);

			const blob = new Blob([arrayBuffer]);
			const fileObj = new File([blob], file.name);

			// 保存到CAS
			const { cid } = await this.plugin.cas.save(fileObj);

			const url = new URL(`ipfs://${cid}`);
			url.searchParams.set("filename", file.name);
			return {
				success: true,
				url: url.toString(),
			};
		} catch (error) {
			console.warn(`迁移文件失败: ${file.path}`, error);
			return {
				success: false,
				error: error.message,
			};
		}
	}
}

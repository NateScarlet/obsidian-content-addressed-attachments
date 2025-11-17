import { App, TFile, LinkCache } from "obsidian";
import ContentAddressedAttachmentPlugin from "./main";
import defineLocales from "./utils/defineLocales";
import { MigrationProgressModal } from "./ui/MigrationProgressModal";

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
		migrationCancelled: "Migration cancelled by user",
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
		migrationCancelled: "迁移已被用户取消",
	},
});
//#endregion

export interface MigrationProgress {
	status: "processing" | "completed" | "cancelled";
	currentFile?: number;
	totalFiles?: number;
	currentFileName?: string;
	migrated: number;
	skipped: number;
	errors: number;
	details: string[];
	cancelled?: boolean;
}

interface MigrationContext {
	signal: AbortSignal;
	updateProgress(progress: MigrationProgress): void;
}

export interface MigrationResult extends MigrationProgress {
	success: boolean;
}

export class MigrationManager {
	private app: App;
	private currentStack: DisposableStack | undefined;

	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		this.app = plugin.app;
	}

	async execute(scope: "current" | "all"): Promise<MigrationResult> {
		this.currentStack?.dispose();
		const stack = new DisposableStack();
		this.currentStack = stack;
		const ctr = stack.adopt(new AbortController(), (i) => i.abort());
		const modal = stack.adopt(
			new MigrationProgressModal(this.app, ctr),
			(i) => i.close(),
		);
		modal.open();

		const ctx: MigrationContext = {
			signal: ctr.signal,
			updateProgress(progress) {
				modal.updateProgress(progress);
			},
		};

		try {
			let result: MigrationResult;
			if (scope === "current") {
				result = await this.migrateCurrentNote(ctx);
			} else {
				result = await this.migrateAllNotes(ctx);
			}
			ctx.updateProgress(result);
			if (result.cancelled) {
				modal.showCancelled();
			} else if (!result.success) {
				modal.showError("Migration failed");
			}

			return result;
		} catch (error) {
			modal.showError(String(error));
			throw error;
		} finally {
			if (this.currentStack === stack) {
				this.currentStack = undefined; // 允许回收
			}
		}
	}

	[Symbol.dispose]() {
		this.currentStack?.dispose();
	}

	private async migrateCurrentNote(
		ctx: MigrationContext,
	): Promise<MigrationResult> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			throw new Error(t("noActiveNote"));
		}

		const progress = await this.migrateNote(ctx, file);
		return {
			...progress,
			success: true,
			status: "completed",
		};
	}

	private async migrateAllNotes(
		ctx: MigrationContext,
	): Promise<MigrationResult> {
		const files = this.app.vault.getMarkdownFiles();
		const result: MigrationProgress = {
			status: "processing",
			migrated: 0,
			skipped: 0,
			errors: 0,
			details: [],
			currentFile: 0,
			totalFiles: files.length,
		};

		ctx.updateProgress(result);

		for (let i = 0; i < files.length; i++) {
			if (ctx.signal.aborted) {
				result.status = "cancelled";
				result.cancelled = true;
				result.details.push(t("migrationCancelled"));
				return { ...result, success: false };
			}

			const file = files[i];
			result.currentFile = i + 1;
			result.currentFileName = file.name;

			ctx.updateProgress(result);

			try {
				const noteResult = await this.migrateNote(ctx, file);
				result.migrated += noteResult.migrated;
				result.skipped += noteResult.skipped;
				result.errors += noteResult.errors;
				result.details.push(...noteResult.details);

				ctx.updateProgress(result);
			} catch (err) {
				result.errors++;
				result.details.push(
					t("errorProcessingNote")(file.path, String(err)),
				);
				ctx.updateProgress(result);
			}
		}

		result.status = "completed";
		return { ...result, success: result.errors === 0 };
	}

	private async migrateNote(
		ctx: MigrationContext,
		file: TFile,
	): Promise<MigrationProgress> {
		const result: MigrationProgress = {
			status: "processing",
			migrated: 0,
			skipped: 0,
			errors: 0,
			details: [],
		};

		try {
			if (ctx.signal.aborted) {
				result.status = "cancelled";
				result.cancelled = true;
				return result;
			}

			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) {
				result.skipped++;
				result.details.push(t("skipNoteNoMetadata")(file.path));
				return result;
			}

			const links: LinkCache[] = [];
			if (cache.links) links.push(...cache.links);
			if (cache.embeds) links.push(...cache.embeds);

			if (links.length === 0) {
				result.skipped++;
				result.details.push(t("skipNote")(file.path));
				return result;
			}

			let content = await this.app.vault.read(file);
			let migratedCount = 0;

			const sortedLinks = [...links].sort(
				(a, b) => b.position.start.offset - a.position.start.offset,
			);

			for (const link of sortedLinks) {
				if (ctx.signal.aborted) {
					result.status = "cancelled";
					result.cancelled = true;
					break;
				}

				try {
					const migrationResult = await this.migrateLink(
						ctx,
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
				} catch (err) {
					result.errors++;
					result.details.push(
						t("errorProcessingLink")(link.link, String(err)),
					);
				}
			}

			if (migratedCount > 0 && !ctx.signal.aborted) {
				await this.app.vault.modify(file, content);
				result.migrated = migratedCount;
				result.details.unshift(
					t("updatedNote")(file.path, migratedCount),
				);
			} else {
				result.skipped++;
				result.details.unshift(t("noMigrationNeeded")(file.path));
			}
		} catch (err) {
			result.errors++;
			result.details.push(
				t("errorProcessingNote")(file.path, String(err)),
			);
		}

		return result;
	}

	private async migrateLink(
		ctx: MigrationContext,
		link: LinkCache,
		content: string,
		notePath: string,
	): Promise<{
		success: boolean;
		newContent?: string;
		url?: string;
		reason?: string;
	}> {
		if (ctx.signal.aborted) {
			return { success: false, reason: "Cancelled" };
		}

		if (link.link.startsWith("http")) {
			return { success: false, reason: t("externalLink") };
		}

		if (link.link.startsWith("ipfs://")) {
			return { success: false, reason: t("alreadyIPFS") };
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(
			link.link,
			notePath,
		);
		if (!file) {
			return { success: false, reason: t("cannotResolvePath") };
		}
		console.debug(file.extension);
		switch (file.extension) {
			case "txt":
			case "md":
				return { success: false, reason: t("excludedFile") };
		}

		if (!file) {
			console.debug("文件不存在", { link, notePath });
			return { success: false, reason: t("fileNotExist") };
		}

		const result = await this.migrateFile(ctx, file);
		if (!result.success) {
			return { success: false, reason: t("fileMigrationFailed") };
		}

		let newLinkText: string;
		let title = link.link || file.basename;
		if (link.displayText != title) {
			title += `|${link.displayText}`;
		}
		if (link.original.startsWith("!")) {
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

	private async migrateFile(
		ctx: MigrationContext,
		file: TFile,
	): Promise<{
		success: boolean;
		url?: string;
		error?: string;
	}> {
		if (ctx.signal.aborted) {
			return { success: false, error: "Cancelled" };
		}

		try {
			const arrayBuffer = await this.app.vault.readBinary(file);

			const blob = new Blob([arrayBuffer]);
			const fileObj = new File([blob], file.name);

			const { cid } = await this.plugin.cas.save(fileObj);

			const url = new URL(`ipfs://${cid.toString()}`);
			url.searchParams.set("filename", file.name);
			return {
				success: true,
				url: url.toString(),
			};
		} catch (error) {
			console.warn(`迁移文件失败: ${file.path}`, error);
			return {
				success: false,
				error: String(error),
			};
		}
	}
}

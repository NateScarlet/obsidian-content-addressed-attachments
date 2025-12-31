import { App, TFile } from "obsidian";
import ContentAddressedAttachmentPlugin from "./main";
import defineLocales from "./utils/defineLocales";
import { LockProgressModal } from "./ui/LockProgressModal";
import { requestUrl } from "obsidian";

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		externalLink: "External link",
		alreadyIPFS: "Already IPFS link",
		alreadyLocked: "Already locked link",
		cannotResolvePath: "Cannot resolve file path",
		excludedFile: "Excluded File",
		fileNotExist: "File does not exist",
		fileLockFailed: "File lock failed",
		skipNote: (path: string) =>
			`Skipped note ${path}: no external embedded links`,
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
			`Updated note ${path}: migrated ${count} external embedded links`,
		noLockNeeded: (path: string) =>
			`Skipped note ${path}: no external embedded links to migrate`,
		noActiveNote: "No active note",
		lockCancelled: "Lock cancelled by user",
		notHTTPLink: "Not an HTTP/HTTPS link",
		nonEmbeddedLink: "Non-embedded link (skipping)",
		downloadFailed: "Failed to download file",
		invalidURL: "Invalid URL",
		unsupportedProtocol: "Unsupported protocol",
	},
	zh: {
		externalLink: "外部链接",
		alreadyIPFS: "已是IPFS链接",
		alreadyLocked: "已是锁定链接",
		excludedFile: "排除的文件",
		cannotResolvePath: "无法解析文件路径",
		fileNotExist: "文件不存在",
		fileLockFailed: "文件迁移失败",
		skipNote: (path: string) => `跳过笔记 ${path}: 无外部嵌入链接`,
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
			`已更新笔记 ${path}: 迁移了 ${count} 个外部嵌入链接`,
		noLockNeeded: (path: string) =>
			`跳过笔记 ${path}: 没有可迁移的外部嵌入链接`,
		noActiveNote: "没有活动的笔记",
		lockCancelled: "迁移已被用户取消",
		notHTTPLink: "非HTTP/HTTPS链接",
		nonEmbeddedLink: "非嵌入链接(跳过)",
		downloadFailed: "下载文件失败",
		invalidURL: "无效的URL",
		unsupportedProtocol: "不支持的协议",
	},
});
//#endregion

export interface LockProgress {
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

interface LockContext {
	signal: AbortSignal;
	updateProgress(progress: LockProgress): void;
}

export interface LockResult extends LockProgress {
	success: boolean;
}

interface ParsedLink {
	start: number;
	end: number;
	original: string;
	link: string;
	displayText?: string;
	title?: string;
	isEmbedded: boolean;
}

export class LockManager {
	private app: App;
	private currentStack: DisposableStack | undefined;

	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		this.app = plugin.app;
	}

	async execute(scope: "current" | "all"): Promise<LockResult> {
		this.currentStack?.dispose();
		const stack = new DisposableStack();
		this.currentStack = stack;
		const ctr = stack.adopt(new AbortController(), (i) => i.abort());
		const modal = stack.adopt(new LockProgressModal(this.app, ctr), (i) =>
			i.close(),
		);
		modal.open();

		const ctx: LockContext = {
			signal: ctr.signal,
			updateProgress(progress) {
				modal.updateProgress(progress);
			},
		};

		try {
			let result: LockResult;
			if (scope === "current") {
				result = await this.migrateCurrentNote(ctx);
			} else {
				result = await this.migrateAllNotes(ctx);
			}
			ctx.updateProgress(result);
			if (result.cancelled) {
				modal.showCancelled();
			} else if (!result.success) {
				modal.showError("Lock failed");
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

	private async migrateCurrentNote(ctx: LockContext): Promise<LockResult> {
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

	private async migrateAllNotes(ctx: LockContext): Promise<LockResult> {
		const files = this.app.vault.getMarkdownFiles();
		const result: LockProgress = {
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
				result.details.push(t("lockCancelled"));
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
		ctx: LockContext,
		file: TFile,
	): Promise<LockProgress> {
		const result: LockProgress = {
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

			let content = await this.app.vault.read(file);

			// 解析嵌入链接
			const embeddedLinks = this.parseEmbeddedLinks(content);

			if (embeddedLinks.length === 0) {
				result.skipped++;
				result.details.push(t("skipNote")(file.path));
				return result;
			}

			let migratedCount = 0;

			// 从后往前处理，避免位置偏移
			const sortedLinks = [...embeddedLinks].sort(
				(a, b) => b.start - a.start,
			);

			for (const link of sortedLinks) {
				if (ctx.signal.aborted) {
					result.status = "cancelled";
					result.cancelled = true;
					break;
				}

				try {
					const lockResult = await this.migrateLink(
						ctx,
						link,
						content,
					);
					if (lockResult.success && lockResult.newContent) {
						content = lockResult.newContent;
						migratedCount++;
						result.details.push(
							t("migratedLink")(link.link, lockResult.url || ""),
						);
					} else {
						result.skipped++;
						result.details.push(
							t("skippedLink")(
								link.link,
								lockResult.reason || "",
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
				result.details.unshift(t("noLockNeeded")(file.path));
			}
		} catch (err) {
			result.errors++;
			result.details.push(
				t("errorProcessingNote")(file.path, String(err)),
			);
		}

		return result;
	}

	private parseEmbeddedLinks(content: string): ParsedLink[] {
		const links: ParsedLink[] = [];

		// 正则表达式匹配嵌入链接: ![alt](url "title")
		// 也支持无标题: ![alt](url)
		const embedRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

		let match;
		while ((match = embedRegex.exec(content)) !== null) {
			const [fullMatch, displayText, link, title] = match;
			const start = match.index;
			const end = start + fullMatch.length;

			links.push({
				start,
				end,
				original: fullMatch,
				link: link.trim(),
				displayText: displayText || undefined,
				title: title || undefined,
				isEmbedded: true,
			});
		}

		return links;
	}

	private async migrateLink(
		ctx: LockContext,
		link: ParsedLink,
		content: string,
	): Promise<{
		success: boolean;
		newContent?: string;
		url?: string;
		reason?: string;
	}> {
		if (ctx.signal.aborted) {
			return { success: false, reason: "Cancelled" };
		}

		// 只处理HTTP/HTTPS链接
		const lowerLink = link.link.toLowerCase();
		if (
			!lowerLink.startsWith("http://") &&
			!lowerLink.startsWith("https://")
		) {
			return { success: false, reason: t("notHTTPLink") };
		}

		// 检查是否已经是ipfs链接
		if (link.link.startsWith("ipfs://")) {
			return { success: false, reason: t("alreadyIPFS") };
		}

		// 检查是否已经是锁定链接
		if (link.link.startsWith("internal.ipfs-locked:")) {
			return { success: false, reason: t("alreadyLocked") };
		}

		const result = await this.migrateFromURL(ctx, link.link);
		if (!result.success) {
			return {
				success: false,
				reason: result.error || t("fileLockFailed"),
			};
		}

		let newLinkText: string;

		// 构建新的alt文本
		const altText = link.displayText || link.link;
		if (link.title) {
			newLinkText = `![${altText}](${result.newURL} "${link.title}")`;
		} else {
			newLinkText = `![${altText}](${result.newURL})`;
		}

		const newContent =
			content.substring(0, link.start) +
			newLinkText +
			content.substring(link.end);

		return {
			success: true,
			newContent,
			url: result.newURL,
		};
	}

	private async migrateFromURL(
		ctx: LockContext,
		url: string,
	): Promise<{
		success: boolean;
		newURL?: string;
		error?: string;
	}> {
		if (ctx.signal.aborted) {
			return { success: false, error: "Cancelled" };
		}

		try {
			// 验证URL
			let parsedURL: URL;
			try {
				parsedURL = new URL(url);
			} catch {
				return { success: false, error: t("invalidURL") };
			}

			if (
				parsedURL.protocol !== "http:" &&
				parsedURL.protocol !== "https:"
			) {
				return { success: false, error: t("unsupportedProtocol") };
			}

			const response = await requestUrl({
				url,
				throw: false,
			});

			if (response.status !== 200) {
				return {
					success: false,
					error: `${t("downloadFailed")}: HTTP ${response.status}`,
				};
			}

			const arrayBuffer = response.arrayBuffer;
			const blob = new Blob([arrayBuffer]);

			// 从URL提取文件名
			const pathname = parsedURL.pathname;
			let filename = pathname.split("/").pop() || "unknown";

			// 如果URL中有查询参数，尝试从Content-Disposition获取文件名
			const contentDisposition = response.headers["content-disposition"];
			if (contentDisposition) {
				const match = contentDisposition.match(/filename="?([^"]+)"?/i);
				if (match?.[1]) {
					filename = match[1];
				}
			}

			const fileObj = new File([blob], filename, {
				type:
					response.headers["content-type"] ||
					"application/octet-stream",
			});

			// 使用cacheDir如果设置，否则使用primaryDir
			const targetDir =
				this.plugin.settings.downloadDir ||
				this.plugin.settings.primaryDir;

			const { cid } = await this.plugin.cas.save(targetDir, fileObj);

			// 创建新的锁定链接格式
			const newURL = `internal.ipfs-locked:${cid.toString()},${url}`;

			return {
				success: true,
				newURL,
			};
		} catch (error) {
			console.warn(`迁移URL失败: ${url}`, error);
			return {
				success: false,
				error: String(error),
			};
		}
	}
}

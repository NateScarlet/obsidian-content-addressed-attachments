import { App, TFile } from "obsidian";
import ContentAddressedAttachmentPlugin from "./main";
import defineLocales from "./utils/defineLocales";
import { LockProgressModal } from "./ui/LockProgressModal";
import { requestUrl } from "obsidian";
import { basename } from "path-browserify";

export interface LockProgress {
	status: "processing" | "completed" | "cancelled";
	currentFile?: number;
	totalFiles?: number;
	currentFileName?: string;
	migratedLinks: number;
	skippedLinks: number;
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
				result = await this.processCurrentNote(ctx);
			} else {
				result = await this.processAllNotes(ctx);
			}
			ctx.updateProgress(result);
			if (result.cancelled) {
				modal.showCancelled();
			} else if (!result.success) {
				modal.showError("Lock failed");
			}
			if (result.success && scope === "current") {
				modal.close();
			}
			return result;
		} catch (error) {
			modal.showError(String(error));
			throw error;
		}
	}

	[Symbol.dispose]() {
		this.currentStack?.dispose();
	}

	private async processCurrentNote(ctx: LockContext): Promise<LockResult> {
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

	private async processAllNotes(ctx: LockContext): Promise<LockResult> {
		const files = this.app.vault.getMarkdownFiles();
		const result: LockProgress = {
			status: "processing",
			migratedLinks: 0,
			skippedLinks: 0,
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
				result.details.push(t("cancelled"));
				return { ...result, success: false };
			}

			const file = files[i];
			result.currentFile = i + 1;
			result.currentFileName = file.name;

			ctx.updateProgress(result);

			try {
				const noteResult = await this.migrateNote(ctx, file);
				result.migratedLinks += noteResult.migratedLinks;
				result.skippedLinks += noteResult.skippedLinks;
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
			migratedLinks: 0,
			skippedLinks: 0,
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
			const embeddedLinks = Array.from(this.findEmbeddedLinks(content));

			if (embeddedLinks.length === 0) {
				result.details.push(t("skipNote")(file.path));
				return result;
			}

			let migratedCount = 0;

			// 从后往前处理，避免位置偏移
			embeddedLinks.reverse();

			for (const link of embeddedLinks) {
				if (ctx.signal.aborted) {
					result.status = "cancelled";
					result.cancelled = true;
					break;
				}

				try {
					const lockResult = await this.migrateLink(link, content);
					if (lockResult.success && lockResult.newContent) {
						content = lockResult.newContent;
						migratedCount++;
						result.details.push(
							t("migratedLink")(link.link, lockResult.url || ""),
						);
					} else {
						result.skippedLinks++;
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
				result.migratedLinks = migratedCount;
				result.details.unshift(
					t("updatedNote")(file.path, migratedCount),
				);
			}
		} catch (err) {
			result.errors++;
			result.details.push(
				t("errorProcessingNote")(file.path, String(err)),
			);
		}

		return result;
	}

	private *findEmbeddedLinks(content: string) {
		// 正则表达式匹配嵌入链接: ![alt](url "title")
		// 也支持无标题: ![alt](url)
		const embedRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

		let match;
		while ((match = embedRegex.exec(content)) !== null) {
			const [fullMatch, displayText, link, title] = match;
			const start = match.index;
			const end = start + fullMatch.length;

			yield {
				start,
				end,
				original: fullMatch,
				link: link.trim(),
				displayText: displayText || undefined,
				title: title || undefined,
				isEmbedded: true,
			} satisfies ParsedLink;
		}
	}

	private async migrateLink(
		link: ParsedLink,
		content: string,
	): Promise<{
		success: boolean;
		newContent?: string;
		url?: string;
		reason?: string;
	}> {
		// 只处理HTTP/HTTPS链接
		const lowerLink = link.link.toLowerCase();
		if (
			!(
				lowerLink.startsWith("http://") ||
				lowerLink.startsWith("https://")
			)
		) {
			return { success: false, reason: t("notHTTPLink") };
		}

		const result = await this.migrateFromURL(link.link);
		if (!result.success) {
			return {
				success: false,
				reason: result.error || t("fileLockFailed"),
			};
		}

		const newContent =
			content.substring(0, link.start) +
			link.original.replace("(" + link.link, "(" + result.newURL) +
			content.substring(link.end);

		return {
			success: true,
			newContent,
			url: result.newURL,
		};
	}

	private async migrateFromURL(url: string): Promise<{
		success: boolean;
		newURL?: string;
		error?: string;
	}> {
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
			const filename = basename(pathname);

			const fileObj = new File([blob], filename, {
				type:
					response.headers["content-type"] ||
					"application/octet-stream",
			});

			const dir =
				this.plugin.settings.downloadDir ||
				this.plugin.settings.primaryDir;

			const { cid } = await this.plugin.cas.save(dir, fileObj);

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

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		externalLink: "External link",
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
		noActiveNote: "No active note",
		cancelled: "Lock cancelled by user",
		notHTTPLink: "Not an HTTP/HTTPS link",
		nonEmbeddedLink: "Non-embedded link (skipping)",
		downloadFailed: "Failed to download file",
		invalidURL: "Invalid URL",
		unsupportedProtocol: "Unsupported protocol",
	},
	zh: {
		externalLink: "外部链接",
		excludedFile: "排除的文件",
		cannotResolvePath: "无法解析文件路径",
		fileNotExist: "文件不存在",
		fileLockFailed: "文件迁移失败",
		skipNote: (path: string) => `跳过笔记 ${path}: 无外部嵌入链接`,
		skipNoteNoMetadata: (path: string) => `跳过笔记 ${path}: 无元数据缓存`,
		errorProcessingNote: (path: string, error: string) =>
			`处理笔记 ${path} 时出错: ${error}`,
		errorProcessingLink: (link: string, error: string) =>
			`处理链接 ${link} 时出错: ${error}`,
		migratedLink: (oldLink: string, newLink: string) =>
			`迁移链接: ${oldLink} -> ${newLink}`,
		skippedLink: (link: string, reason: string) =>
			`跳过链接: ${link} (${reason})`,
		updatedNote: (path: string, count: number) =>
			`已更新笔记 ${path}: 迁移了 ${count} 个外部嵌入链接`,
		noActiveNote: "没有活动的笔记",
		cancelled: "已被用户取消",
		notHTTPLink: "非HTTP/HTTPS链接",
		nonEmbeddedLink: "非嵌入链接(跳过)",
		downloadFailed: "下载文件失败",
		invalidURL: "无效的URL",
		unsupportedProtocol: "不支持的协议",
	},
});
//#endregion

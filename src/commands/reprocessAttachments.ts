import { Notice, type App, type TFile, type Editor } from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type EncryptionService from "#src/lib/encryption/EncryptionService";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type { URLResolver } from "#src/URLResolver";
import type ReferenceManager from "#src/ReferenceManager";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import findIPFSLinks, { type IPFSLinkMatch } from "#src/utils/findIPFSLinks";
import IPFSLink from "#src/utils/IPFSLink";
import VaultLinkTransformer from "#src/utils/VaultLinkTransformer";
import defineLocales from "#src/utils/defineLocales";
import type KeyManager from "#src/lib/encryption/KeyManager";
import showError from "#src/utils/showError";
import { ProgressModal } from "#src/ui/ProgressModal";

const { t } = defineLocales({
	en: {
		reprocessCurrentNote: "Reprocess attachments (current note)",
		reprocessWholeVault:
			"Reprocess all attachments (whole vault, advanced)",
		reprocessConfirm:
			"This will reprocess all referenced attachments in the vault. This operation is hard to revert. Continue?",
		reprocessCancelled: "Reprocess cancelled",
		reprocessComplete: (count: number) =>
			`Reprocessed ${count} attachment(s)`,
		reprocessProgress: (current: number, total: number) =>
			`Reprocessing attachment ${current}/${total}`,
		noScriptConfigured: "No pre-processing script configured",
		noAttachmentsFound: "No attachments found to reprocess",
	},
	zh: {
		reprocessCurrentNote: "重新处理附件（当前笔记）",
		reprocessWholeVault: "重新处理所有附件（全库，高级操作）",
		reprocessConfirm:
			"将重新处理仓库中所有被引用的附件。此操作难以撤销。是否继续？",
		reprocessCancelled: "已取消重新处理",
		reprocessComplete: (count: number) =>
			`已重新处理 ${count} 个附件`,
		reprocessProgress: (current: number, total: number) =>
			`正在重新处理附件 ${current}/${total}`,
		noScriptConfigured: "未配置预处理脚本",
		noAttachmentsFound: "未找到需要重新处理的附件",
	},
});

//#region Shared context

export interface ReprocessContext {
	app: App;
	cas: CAS;
	encryptionService: EncryptionService;
	urlResolver: URLResolver;
	referenceManager: ReferenceManager;
	keyManager: KeyManager;
	encryptPathPolicy: EncryptPathPolicy;
	pipeline: TransformPipeline;
	scriptURL: string;
	dir: string;
}

//#endregion

//#region Helpers

async function trashIfUnreferenced(
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

async function loadFileContent(
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

//#endregion

//#region Core reprocess logic

/**
 * 重新处理单个附件链接：解密 → 管线转换 → 重新加密 → 保存 → 清理旧文件
 */
async function reprocessSingleLink(
	ctx: ReprocessContext,
	linkText: string,
	notePath: string,
): Promise<string | undefined> {
	if (!ctx.scriptURL) {
		new Notice(t("noScriptConfigured"));
		return undefined;
	}

	const parsed = IPFSLink.parse(linkText);
	if (!parsed) return undefined;

	// 加载文件内容（解密如果需要）
	const buffer = await loadFileContent(
		ctx.app,
		ctx.cas,
		ctx.urlResolver,
		linkText,
	);
	if (!buffer) return undefined;

	// 如果文件是加密的，先解密
	let plaintext: ArrayBuffer;
	let originalMimeType: string;
	if (parsed.format === ENCRYPTED_FORMAT) {
		const decrypted = await ctx.encryptionService.ensureDecrypted(buffer);
		if (decrypted.layers.length === 0) return undefined;
		plaintext = decrypted.data;
		originalMimeType = decrypted.mimeType;
	} else {
		plaintext = buffer;
		originalMimeType = parsed.resolveMimeType();
	}

	// 运行管线
	const result = await ctx.pipeline.run(
		{
			data: plaintext,
			mimeType: originalMimeType,
			filename: parsed.filename || "file",
		},
		ctx.scriptURL,
	);

	// 如果管线返回 undefined，保留原始文件
	if (!result) return undefined;

	// 如果管线结果与原文件相同（MIME 和大小未变），跳过
	if (result.mimeType === originalMimeType && result.data.byteLength === plaintext.byteLength) {
		return undefined;
	}

	// 重新加密（如果需要）
	const transformedFile = new File(
		[new Blob([result.data], { type: result.mimeType })],
		result.filename,
		{ type: result.mimeType },
	);
	const fileToSave =
		(await ctx.encryptPathPolicy.ensureEncrypted(
			transformedFile,
			notePath,
		)) ?? transformedFile;

	// 保存新文件
	const { cid: newCid } = await ctx.cas.save(ctx.dir, fileToSave);

	// 清理旧文件
	if (!newCid.equals(parsed.cid)) {
		await trashIfUnreferenced(
			ctx.cas,
			ctx.referenceManager,
			parsed.cid,
			notePath,
		);
	}

	return new IPFSLink({
		cid: newCid,
		filename: fileToSave.name,
		format: fileToSave === transformedFile ? fileToSave.type : ENCRYPTED_FORMAT,
	}).toURL();
}

//#endregion

//#region Public commands

/**
 * 重新处理当前笔记的所有附件引用。
 */
export async function reprocessCurrentNote(ctx: ReprocessContext): Promise<number> {
	const file = ctx.app.workspace.getActiveFile();
	if (!file) {
		throw new Error("No active note");
	}

	const transformer = new VaultLinkTransformer(ctx.app);
	return transformer.transformFile(file, async (_match, linkText) => {
		return reprocessSingleLink(ctx, linkText, file.path);
	});
}

/**
 * 重新处理编辑器中的单个链接。
 */
export async function reprocessSingleLinkCommand(
	ctx: ReprocessContext,
	editor: Editor,
	match: IPFSLinkMatch,
	notePath: string | undefined,
): Promise<void> {
	const linkText =
		typeof match.url.toURL === "function" ? match.url.toURL() : undefined;
	if (!linkText) return;

	const newURL = await reprocessSingleLink(ctx, linkText, notePath ?? "");
	if (!newURL) return;

	editor.replaceRange(
		newURL,
		editor.offsetToPos(match.pos[0]),
		editor.offsetToPos(match.pos[1]),
	);
}

/**
 * 重新处理全库所有附件引用。
 * 需要确认对话框。
 */
export async function reprocessWholeVault(
	ctx: ReprocessContext,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const modal = new ProgressModal(
			ctx.app,
			t("reprocessWholeVault"),
			async (progress) => {
				const files = ctx.app.vault.getMarkdownFiles();
				let totalReprocessed = 0;
				let processed = 0;

				progress.update(t("reprocessProgress")(0, files.length));

				for (const file of files) {
					if (progress.isCancelled) {
						new Notice(t("reprocessCancelled"));
						break;
					}

					const transformer = new VaultLinkTransformer(ctx.app);
					const count = await transformer.transformFile(
						file,
						async (_match, linkText) => {
							return reprocessSingleLink(
								ctx,
								linkText,
								file.path,
							);
						},
					);
					totalReprocessed += count;
					processed++;
					progress.update(
						t("reprocessProgress")(processed, files.length),
					);
				}

				return totalReprocessed;
			},
		);
		modal.open();
		modal.onCompleted = (count: number) => {
			new Notice(t("reprocessComplete")(count));
			resolve(count);
		};
		modal.onError = (err: unknown) => {
			showError(err);
			reject(err);
		};
	});
}

//#endregion
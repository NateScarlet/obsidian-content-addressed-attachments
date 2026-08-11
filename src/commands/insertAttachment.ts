import { MarkdownView, Notice, type App, type Editor } from "obsidian";
import type { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import IPFSLink from "#src/utils/IPFSLink";
import defineLocales from "#src/utils/defineLocales";
import {
	createPreprocessPlaceholder,
	replacePlaceholderInEditorOrVault,
	type PlaceholderReplaceVault,
} from "#src/utils/preprocessPlaceholder";

/** 插入附件所需的最小 Editor 接口 */
type InsertAttachmentEditor = Pick<
	Editor,
	"replaceSelection" | "getValue" | "offsetToPos" | "replaceRange"
>;

// #region 插入附件：链接格式化与处理主流程
function formatIPFSLinkMarkdown(
	fileToProcess: File,
	fileToSave: File,
	cid: CID,
): string {
	const link = new IPFSLink({
		cid,
		filename: fileToSave.name,
		format: fileToSave.type,
	});
	return link.toMarkdown(fileToProcess.type.startsWith("image/"));
}

export async function processFileAndInsertLink(
	cas: CAS,
	dir: string,
	editor: InsertAttachmentEditor,
	file: File,
	notePath: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline: TransformPipeline,
	vault: PlaceholderReplaceVault,
): Promise<void> {
	// 1. 检查是否启用了预处理脚本（若没有脚本 URL 则无需占位符，直接即时落盘）
	const scriptURL = pipeline.getScriptURL();
	if (!scriptURL) {
		const fileToSave =
			(await encryptPathPolicy.ensureEncrypted(file, notePath)) ?? file;
		const { cid } = await cas.save(dir, fileToSave);
		const linkMarkdown = formatIPFSLinkMarkdown(file, fileToSave, cid);
		editor.replaceSelection(linkMarkdown);
		return;
	}

	// 2. 启用了预处理：瞬间生成唯一注释占位符并插入光标处（UI 0 延迟卡顿）
	const { placeholder } = createPreprocessPlaceholder(file.name);
	editor.replaceSelection(placeholder);
	// 传入 timeout 0 使 Notification 在预处理期间持续展示，避免超时提前消失
	const notice = new Notice(t("processing")(file.name), 0);

	// 3. 启动后台异步任务进行转码、加密与落盘，完成后替换占位符
	const backgroundProcess = async () => {
		const input = {
			data: await file.arrayBuffer(),
			mimeType: file.type,
			filename: file.name,
		};

		// 只有管线执行失败才回退到原始文件；加密/落盘错误原样向上抛，交由外层处理
		const result = await pipeline.run(input).catch((err) => {
			console.warn(
				"[preprocess] Pipeline failed, falling back to original file:",
				err,
			);
			new Notice(t("processFailed")(file.name));
			return undefined;
		});

		// 管线返回 undefined（脚本放弃转换）或失败时都用原始文件落盘
		const fileToProcess = result
			? new File([result.data], result.filename, {
					type: result.mimeType,
				})
			: file;
		const fileToSave =
			(await encryptPathPolicy.ensureEncrypted(
				fileToProcess,
				notePath,
			)) ?? fileToProcess;
		const { cid } = await cas.save(dir, fileToSave);
		const linkMarkdown = formatIPFSLinkMarkdown(
			fileToProcess,
			fileToSave,
			cid,
		);
		notice.hide();

		// 替换编辑器或 Vault 磁盘中的占位符
		const replaced = await replacePlaceholderInEditorOrVault(
			vault,
			editor,
			notePath,
			placeholder,
			linkMarkdown,
		);
		if (!replaced) {
			new Notice(t("replaceFailed")(file.name, linkMarkdown));
		}
	};

	// 异步执行，主函数同步/瞬时返回；加密/落盘失败也要告知用户，避免占位符残留
	void backgroundProcess().catch((err) => {
		notice.hide();
		console.error("[preprocess] Failed to save attachment:", err);
		const errorMessage = err instanceof Error ? err.message : String(err);
		new Notice(t("saveFailed")(file.name, errorMessage));
	});
}

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline: TransformPipeline,
) {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		throw new Error("no markdown view active");
	}
	const handles = await window.showOpenFilePicker({
		id: "insert-attachment-ee03d94fe3c6",
		multiple: true,
	});
	const files = await Promise.all(handles.map((h) => h.getFile()));
	const editor = view.editor;
	const notePath = view.file?.path ?? "";

	for (const file of files) {
		await processFileAndInsertLink(
			cas,
			dir,
			editor,
			file,
			notePath,
			encryptPathPolicy,
			pipeline,
			app.vault,
		);
	}
}
// #endregion

const { t } = defineLocales({
	en: {
		processing: (name: string) =>
			`[preprocess] Preprocessing attachment: ${name}...`,
		processFailed: (name: string) =>
			`[preprocess] Preprocessing ${name} failed, falling back to original file`,
		saveFailed: (name: string, error: string) =>
			`[preprocess] Failed to save attachment ${name}: ${error}`,
		replaceFailed: (name: string, link: string) =>
			`[preprocess] ${name} processed but its placeholder was not found; insert the link manually: ${link}`,
	},
	zh: {
		processing: (name: string) =>
			`[preprocess] 正在后台处理附件：${name}...`,
		processFailed: (name: string) =>
			`[preprocess] 附件 ${name} 预处理失败，使用原图落盘`,
		saveFailed: (name: string, error: string) =>
			`[preprocess] 附件 ${name} 落盘失败：${error}`,
		replaceFailed: (name: string, link: string) =>
			`[preprocess] 附件 ${name} 已处理完成，但未找到占位符自动替换，请手动插入：${link}`,
	},
});

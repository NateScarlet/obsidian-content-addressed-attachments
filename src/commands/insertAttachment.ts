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

// #region 辅助函数：格式化 IPFS 链接
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
// #endregion

// #region 核心处理主流程
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
		/** 加密并保存文件，返回落盘后的 Markdown 链接 */
		const saveAndFormatLink = async (fileToProcess: File) => {
			const fileToSave =
				(await encryptPathPolicy.ensureEncrypted(
					fileToProcess,
					notePath,
				)) ?? fileToProcess;
			const { cid } = await cas.save(dir, fileToSave);
			return formatIPFSLinkMarkdown(fileToProcess, fileToSave, cid);
		};

		let linkMarkdown: string | undefined;

		try {
			const input = {
				data: await file.arrayBuffer(),
				mimeType: file.type,
				filename: file.name,
			};
			const result = await pipeline.run(input);

			// 管线返回 undefined 或抛错时都回退到原始文件
			const fileToProcess = result
				? new File([result.data], result.filename, {
						type: result.mimeType,
					})
				: file;
			linkMarkdown = await saveAndFormatLink(fileToProcess);
		} catch (err) {
			console.warn(
				"[preprocess] Pipeline failed, falling back to original file:",
				err,
			);
			linkMarkdown = await saveAndFormatLink(file);
			new Notice(t("processFailed")(file.name));
		} finally {
			notice.hide();
		}

		// 替换编辑器或 Vault 磁盘中的占位符
		if (linkMarkdown) {
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
		}
	};

	// 异步执行，主函数同步/瞬时返回
	void backgroundProcess();
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
		replaceFailed: (name: string, link: string) =>
			`[preprocess] ${name} processed but its placeholder was not found; insert the link manually: ${link}`,
	},
	zh: {
		processing: (name: string) =>
			`[preprocess] 正在后台处理附件：${name}...`,
		processFailed: (name: string) =>
			`[preprocess] 附件 ${name} 预处理失败，使用原图落盘`,
		replaceFailed: (name: string, link: string) =>
			`[preprocess] 附件 ${name} 已处理完成，但未找到占位符自动替换，请手动插入：${link}`,
	},
});

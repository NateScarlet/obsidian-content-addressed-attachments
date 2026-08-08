import { MarkdownView, Notice, type App, type Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import IPFSLink from "#src/utils/IPFSLink";
import {
	createPreprocessPlaceholder,
	replacePlaceholderInContent,
	replacePlaceholderInEditorOrVault,
} from "#src/utils/preprocessPlaceholder";

// #region 辅助函数：插入占位符与格式化 IPFS 链接
function insertPlaceholderAtCursor(editor: Editor, placeholder: string): void {
	editor.replaceSelection(placeholder);
}

function formatIPFSLinkMarkdown(
	fileToProcess: File,
	fileToSave: File,
	cid: import("multiformats/cid").CID,
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
	editor: Editor,
	file: File,
	notePath: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline: TransformPipeline,
	app?: App,
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
	insertPlaceholderAtCursor(editor, placeholder);
	new Notice(`[preprocess] 正在后台处理附件：${file.name}...`);

	// 3. 启动后台异步任务进行转码、加密与落盘，完成后替换占位符
	const backgroundProcess = async () => {
		let fileToProcess = file;

		try {
			const input = {
				data: await file.arrayBuffer(),
				mimeType: file.type,
				filename: file.name,
			};
			const result = await pipeline.run(input);
			if (result) {
				fileToProcess = new File(
					[result.data],
					result.filename,
					{ type: result.mimeType },
				);
			}
		} catch (err) {
			console.warn(
				"[preprocess] Pipeline failed, falling back to original file:",
				err,
			);
			new Notice(`[preprocess] 附件 ${file.name} 预处理失败，使用原图落盘`);
		}

		// 加密策略决定是否加密
		const fileToSave =
			(await encryptPathPolicy.ensureEncrypted(fileToProcess, notePath)) ??
			fileToProcess;
		const { cid } = await cas.save(dir, fileToSave);
		const linkMarkdown = formatIPFSLinkMarkdown(fileToProcess, fileToSave, cid);

		// 替换编辑器或 Vault 磁盘中的占位符
		if (app) {
			await replacePlaceholderInEditorOrVault(
				app,
				notePath,
				placeholder,
				linkMarkdown,
				editor,
			);
		} else {
			// 在纯 Editor 上测试的降级路径
			const currentText = editor.getValue();
			const updatedText = replacePlaceholderInContent(
				currentText,
				placeholder,
				linkMarkdown,
			);
			if (updatedText !== currentText) {
				editor.setValue(updatedText);
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
			app,
		);
	}
}
// #endregion

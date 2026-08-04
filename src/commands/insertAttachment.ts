import { MarkdownView, type App, type Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import insertIPFSLinkAtCursor from "./insertIPFSLinkAtCursor";
import IPFSLink from "#src/utils/IPFSLink";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";

export async function processFileAndInsertLink(
	cas: CAS,
	dir: string,
	editor: Editor,
	file: File,
	notePath: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline?: TransformPipeline,
	scriptURL?: string,
): Promise<void> {
	// 预处理管线：在加密前运行
	let fileToProcess = file;
	if (pipeline && scriptURL) {
		const input = {
			data: await file.arrayBuffer(),
			mimeType: file.type,
			filename: file.name,
		};
		const result = await pipeline.run(input, scriptURL);
		if (result) {
			fileToProcess = new File(
				[new Blob([result.data], { type: result.mimeType })],
				result.filename,
				{ type: result.mimeType },
			);
		}
	}

	// 合并两个分支：策略加密后若未返回密文则直接使用原始文件
	const fileToSave =
		(await encryptPathPolicy.ensureEncrypted(fileToProcess, notePath)) ??
		fileToProcess;
	const { cid } = await cas.save(dir, fileToSave);
	const link = new IPFSLink({
		cid,
		filename: fileToSave.name,
		format: fileToSave === fileToProcess ? fileToSave.type : ENCRYPTED_FORMAT,
	});
	insertIPFSLinkAtCursor(editor, link, {
		embed: fileToProcess.type.startsWith("image/"),
	});
}

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline?: TransformPipeline,
	scriptURL?: string,
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
			scriptURL,
		);
	}
}
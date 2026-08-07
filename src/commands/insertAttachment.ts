import { MarkdownView, Notice, type App, type Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import insertIPFSLinkAtCursor from "./insertIPFSLinkAtCursor";
import IPFSLink from "#src/utils/IPFSLink";

export async function processFileAndInsertLink(
	cas: CAS,
	dir: string,
	editor: Editor,
	file: File,
	notePath: string,
	encryptPathPolicy: EncryptPathPolicy,
	pipeline: TransformPipeline,
): Promise<void> {
	// 预处理管线：在加密前运行
	let fileToProcess = file;
	{
		const input = {
			data: await file.arrayBuffer(),
			mimeType: file.type,
			filename: file.name,
		};
		try {
			const result = await pipeline.run(input);
			if (result) {
				fileToProcess = new File(
					[new Blob([result.data], { type: result.mimeType })],
					result.filename,
					{ type: result.mimeType },
				);
			}
		} catch (err) {
			console.warn(
				"[preprocess] Pipeline failed, falling back to original file:",
				err,
			);
			new Notice("[preprocess] script failed, keeping original file");
		}
	}

	// 加密策略决定是否加密
	const fileToSave =
		(await encryptPathPolicy.ensureEncrypted(fileToProcess, notePath)) ??
		fileToProcess;
	const { cid } = await cas.save(dir, fileToSave);
	const link = new IPFSLink({
		cid,
		filename: fileToSave.name,
		format: fileToSave.type,
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
		);
	}
}

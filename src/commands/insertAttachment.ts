import { MarkdownView, type App, type Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import insertIPFSLinkAtCursor from "./insertIPFSLinkAtCursor";
import { IPFSLink } from "#src/utils/IPFSLink";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";

export async function processFileAndInsertLink(
	cas: CAS,
	dir: string,
	editor: Editor,
	file: File,
	notePath: string,
	encryptionService?: EncryptionService,
): Promise<void> {
	const res = await encryptionService?.encrypt(file, { notePath });
	if (res) {
		const { encryptedFile } = res;
		const { cid } = await cas.save(dir, encryptedFile);
		const link = new IPFSLink({
			cid,
			filename: file.name,
			format: ENCRYPTED_FORMAT,
		});
		insertIPFSLinkAtCursor(editor, link, {
			embed: file.type.startsWith("image/"),
		});
		return;
	}

	const { cid } = await cas.save(dir, file);
	const link = new IPFSLink({
		cid,
		filename: file.name,
		format: file.type,
	});
	insertIPFSLinkAtCursor(editor, link, {
		embed: file.type.startsWith("image/"),
	});
}

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
	encryptionService?: EncryptionService,
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
			encryptionService,
		);
	}
}

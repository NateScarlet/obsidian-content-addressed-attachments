import { MarkdownView, type App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import insertFileAtCursor from "./insertFileAtCursor";

export interface InsertAttachmentOptions {
	encryptKeyFingerprint?: string;
}

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
	encryptionService?: EncryptionService,
	options?: InsertAttachmentOptions,
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
	for (const file of files) {
		if (
			options?.encryptKeyFingerprint &&
			encryptionService?.isAvailable
		) {
			const { encryptedFile } =
				await encryptionService.encryptFile(
					options.encryptKeyFingerprint,
					file,
				);
			const { cid } = await cas.save(dir, encryptedFile);
			insertFileAtCursor(file, cid, editor, true);
		} else {
			const { cid } = await cas.save(dir, file);
			insertFileAtCursor(file, cid, editor);
		}
	}
}

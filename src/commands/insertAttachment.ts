import { MarkdownView, type App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import type { EncryptPathRule } from "#src/settings";
import ignore from "ignore";
import insertFileAtCursor from "./insertFileAtCursor";

export interface InsertAttachmentOptions {
	encryptKeyFingerprint?: string;
}

function findMatchingRule(
	rules: EncryptPathRule[],
	notePath: string,
): EncryptPathRule | undefined {
	return rules.find((r) => ignore().add(r.pattern).ignores(notePath));
}

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
	encryptionService?: EncryptionService,
	options?: InsertAttachmentOptions,
	encryptPathRules?: EncryptPathRule[],
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
		const fingerprint =
			options?.encryptKeyFingerprint ??
			findMatchingRule(encryptPathRules ?? [], notePath)?.keyFingerprint;

		if (fingerprint && encryptionService?.isAvailable) {
			const { encryptedFile } =
				await encryptionService.encryptFile(fingerprint, file);
			const { cid } = await cas.save(dir, encryptedFile);
			insertFileAtCursor(file, cid, editor, true);
		} else {
			const { cid } = await cas.save(dir, file);
			insertFileAtCursor(file, cid, editor);
		}
	}
}

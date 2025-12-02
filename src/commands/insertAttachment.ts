import { MarkdownView, type App } from "obsidian";
import type { CAS } from "src/types/CAS";
import formatMarkdownLink from "src/utils/formatMarkdownLink";

export default async function insertAttachment(
	app: App,
	cas: CAS,
	dir: string,
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
		const { cid } = await cas.save(dir, file);
		const text = formatMarkdownLink(file, cid);
		editor.replaceRange(
			text,
			editor.getCursor("from"),
			editor.getCursor("to"),
		);
	}
}

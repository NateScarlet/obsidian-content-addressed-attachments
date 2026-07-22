import type { CID } from "multiformats";
import type { Editor } from "obsidian";
import { IPFSLink } from "#src/utils/IPFSLink";

/**
 * @deprecated Use `insertIPFSLinkAtCursor` instead.
 */
export default function insertFileAtCursor(
	file: File,
	cid: CID,
	editor: Editor,
) {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const hasSelection = from.line !== to.line || from.ch !== to.ch;

	const link = new IPFSLink({
		cid,
		filename: file.name,
		format: file.type,
	});
	let text = link.toMarkdown(file.type.startsWith("image/"));
	if (!hasSelection && editor.getLine(from.line).trim() === "") {
		text += "\n";
	}

	editor.replaceSelection(text);

	// 移动光标到后面
	if (!hasSelection) {
		editor.setCursor({
			line: from.line,
			ch: from.ch + text.length,
		});
	}
}

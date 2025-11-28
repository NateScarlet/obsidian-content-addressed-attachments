import type { CID } from "multiformats";
import type { Editor } from "obsidian";
import formatMarkdownLink from "src/utils/formatMarkdownLink";

export default function insertFileAtCursor(
	file: File,
	cid: CID,
	editor: Editor,
) {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const hasSelection = from.line !== to.line || from.ch !== to.ch;

	let text = formatMarkdownLink(file, cid);
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

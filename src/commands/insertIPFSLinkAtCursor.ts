import type { Editor } from "obsidian";
import { IPFSLink } from "#src/utils/IPFSLink";

export default function insertIPFSLinkAtCursor(
	editor: Editor,
	link: IPFSLink,
	options?: { embed?: boolean },
) {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const hasSelection = from.line !== to.line || from.ch !== to.ch;

	const text = link.toMarkdown(options?.embed ?? false);
	const finalText =
		!hasSelection && editor.getLine(from.line).trim() === ""
			? text + "\n"
			: text;

	editor.replaceSelection(finalText);

	// 移动光标到后面
	if (!hasSelection) {
		editor.setCursor({
			line: from.line,
			ch: from.ch + finalText.length,
		});
	}
}

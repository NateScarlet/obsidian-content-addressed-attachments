import type { CID } from "multiformats";
import type { Editor } from "obsidian";
import formatMarkdownLink from "src/utils/formatMarkdownLink";

export default function insertFileAtCursor(
	file: File,
	cid: CID,
	editor: Editor,
) {
	const text = formatMarkdownLink(file, cid);

	editor.replaceRange(text, editor.getCursor("from"), editor.getCursor("to"));
}

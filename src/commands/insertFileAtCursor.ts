import type { CID } from "multiformats";
import type { Editor } from "obsidian";
import { IPFSLink } from "#src/utils/IPFSLink";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";

export default function insertFileAtCursor(
	file: File,
	cid: CID,
	editor: Editor,
	encrypted?: boolean,
) {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const hasSelection = from.line !== to.line || from.ch !== to.ch;

	const link = new IPFSLink({
		cid,
		filename: file.name,
		format: encrypted ? ENCRYPTED_FORMAT : file.type,
	});

	let text = link.toMarkdown();
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

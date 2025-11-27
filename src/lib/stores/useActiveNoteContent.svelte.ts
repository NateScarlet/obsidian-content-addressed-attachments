import { MarkdownView, type App } from "obsidian";
import { writable } from "svelte/store";

function loadByActiveFile(app: App) {
	const activeFile = app.workspace.getActiveFile();
	if (activeFile) {
		for (const i of app.workspace.getLeavesOfType("markdown")) {
			if (
				i.view instanceof MarkdownView &&
				i.view.file?.path === activeFile.path
			) {
				return i.view.editor.getValue();
			}
		}
	}
	return "";
}

export default function useActiveNoteContent(
	app: App,
	enabled?: () => boolean,
) {
	const v = writable("");
	$effect(() => {
		if (enabled?.() === false) {
			v.set("");
			return;
		}

		v.set(loadByActiveFile(app));
		const refs = [
			app.workspace.on("active-leaf-change", (editor) => {
				v.set(loadByActiveFile(app));
			}),
			app.workspace.on("editor-change", (editor) => {
				v.set(editor.getValue());
			}),
		];
		return () => {
			refs.forEach((ref) => app.workspace.offref(ref));
		};
	});
	return v;
}

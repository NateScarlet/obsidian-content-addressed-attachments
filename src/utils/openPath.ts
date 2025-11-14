import { Notice } from "obsidian";

export default function openPath(url: string) {
	const shell = (window as any).electron?.shell;
	if (shell || !url.startsWith("app:")) {
		shell.openPath(url);
	} else {
		const fragment = new DocumentFragment();
		fragment.createEl("a", {
			text: url,
			href: url,
			attr: { target: "_blank" },
		});
		new Notice(fragment);
	}
}

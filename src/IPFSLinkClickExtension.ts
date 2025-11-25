import { EditorView } from "@codemirror/view";
import { FileSystemAdapter } from "obsidian";
import { dirname } from "path-browserify";
import type ContentAddressedAttachmentPlugin from "./main";
import openExternalURL from "./utils/openExternalLink";
import showError from "./utils/showError";

// CodeMirror 扩展：处理编辑器中的 IPFS 链接点击
export default class IPFSLinkClickExtension {
	constructor(private plugin: ContentAddressedAttachmentPlugin) {}

	// 创建 CodeMirror 扩展
	createExtension() {
		return EditorView.domEventHandlers({
			click: (event: MouseEvent, view: EditorView) => {
				if (event.defaultPrevented) {
					return;
				}

				// 获取点击位置
				const pos = view.posAtCoords({
					x: event.clientX,
					y: event.clientY,
				});
				if (pos === null || pos === undefined) return;

				// 获取点击位置的文本范围
				const line = view.state.doc.lineAt(pos);
				const lineText = line.text;

				// 查找 IPFS 链接
				const ipfsRegex = /ipfs:\/\/[^\s)\]]+/g;
				let match: RegExpExecArray | null;
				while ((match = ipfsRegex.exec(lineText)) !== null) {
					const start = match.index;
					const end = start + match[0].length;

					// 检查点击是否在链接范围内
					if (pos >= line.from + start && pos <= line.from + end) {
						const url = match[0];
						this.handleIPFSClick(url, event).catch(showError);
						break;
					}
				}
			},

			// 同时处理 Ctrl+Click 或 Cmd+Click（标准的打开链接行为）
			mousedown: (event: MouseEvent, view: EditorView) => {
				if ((event.ctrlKey || event.metaKey) && event.button === 0) {
					const pos = view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					});
					if (pos === null || pos === undefined) return;

					const line = view.state.doc.lineAt(pos);
					const lineText = line.text;

					const ipfsRegex = /ipfs:\/\/[^\s)\]]+/g;
					let match: RegExpExecArray | null;
					while ((match = ipfsRegex.exec(lineText)) !== null) {
						const start = match.index;
						const end = start + match[0].length;

						if (
							pos >= line.from + start &&
							pos <= line.from + end
						) {
							const url = match[0];
							this.handleIPFSClick(url, event).catch(showError);
							break;
						}
					}
				}
			},
		});
	}

	// 处理 IPFS 链接点击
	private async handleIPFSClick(url: string, event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();

		const resolved = await this.plugin.urlResolver.resolveURL(url);
		if (
			resolved?.path &&
			this.plugin.app.vault.adapter instanceof FileSystemAdapter
		) {
			openExternalURL(
				this.plugin.app.vault.adapter.getFilePath(
					dirname(resolved.path),
				),
			);
		} else {
			openExternalURL(resolved?.url || url);
		}
	}
}

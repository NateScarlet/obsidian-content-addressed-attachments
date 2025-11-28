import { EditorView } from "@codemirror/view";
import showError from "./utils/showError";
import downloadFile from "./commands/downloadFile";
import findIPFSLinks from "./utils/findIPFSLinks";
import type { URLResolver } from "./URLResolver";

// CodeMirror 扩展：处理编辑器中的 IPFS 链接点击
export default function createIPFSLinkClickExtension(urlResolver: URLResolver) {
	return EditorView.domEventHandlers({
		click: (event: MouseEvent, view: EditorView) => {
			if (event.defaultPrevented) {
				return;
			}
			if (!(event.ctrlKey || event.metaKey) || event.button != 0) {
				return;
			}

			const pos = view.posAtCoords({
				x: event.clientX,
				y: event.clientY,
			});
			if (pos === null || pos === undefined) return;

			const line = view.state.doc.lineAt(pos);
			const linePos = pos - line.from;
			for (const {
				pos: [start, end],
				url,
			} of findIPFSLinks(line.text)) {
				if (start <= linePos && end >= linePos) {
					event.preventDefault();
					event.stopPropagation();
					downloadFile(urlResolver, url).catch(showError);
					return;
				}
			}
		},
	});
}

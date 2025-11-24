import { ItemView, WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import CASFileExplorer from "./CASFileExplorer.svelte";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";

export const CAS_FILE_EXPLORER_VIEW_TYPE = "cas-file-explorer";

export class CASFileExplorerView extends ItemView {
	private component?: CASFileExplorer;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ContentAddressedAttachmentPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CAS_FILE_EXPLORER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("casFileExplorer");
	}

	getIcon(): string {
		return "files";
	}

	async onOpen(): Promise<void> {
		this.component = mount(CASFileExplorer, {
			target: this.contentEl,
			props: {
				app: this.plugin.app,
				cas: this.plugin.cas,
				casMetadata: this.plugin.casMetadata,
				referenceManager: this.plugin.referenceManger,
			},
		});
	}

	async onClose(): Promise<void> {
		if (this.component) {
			unmount(this.component);
		}
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		casFileExplorer: "CAS File Explorer",
	},
	zh: {
		casFileExplorer: "CAS 文件管理器",
	},
});
//#endregion

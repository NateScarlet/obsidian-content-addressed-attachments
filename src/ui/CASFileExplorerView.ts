import { ItemView, WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import CASFileExplorer from "#src/lib/CASFileExplorer.svelte";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";

export const CAS_FILE_EXPLORER_VIEW_TYPE = "cas-file-explorer-8974b7f23c81";

export class CASFileExplorerView extends ItemView {
	/** Svelte 5 组件实例（mount 返回值；CASFileExplorer 无导出字段） */
	private component?: Record<string, unknown>;

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
		return "hard-drive";
	}

	onOpen(): Promise<void> {
		this.component = mount(CASFileExplorer, {
			target: this.contentEl,
			props: {
				app: this.plugin.app,
				cas: this.plugin.cas,
				casMetadata: this.plugin.casMetadata,
				referenceManager: this.plugin.referenceManager,
				encryptionService: this.plugin.encryptionService,
			},
		});
		return Promise.resolve();
	}

	async onClose(): Promise<void> {
		if (this.component) {
			await unmount(this.component);
		}
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		casFileExplorer: "CAS file explorer",
	},
	zh: {
		casFileExplorer: "CAS 文件管理器",
	},
});
//#endregion

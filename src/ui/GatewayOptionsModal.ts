import { Modal, type App } from "obsidian";
import type { GatewayConfig } from "src/URLResolver";
import { mount, unmount } from "svelte";
import GatewayOptionsEditor from "src/lib/GatewayOptionsEditor.svelte";
import defineLocales from "src/utils/defineLocales";

export default class GatewayOptionsModal extends Modal {
	private stack = new DisposableStack();

	constructor(
		app: App,
		private config: GatewayConfig,
		private updateConfig: (v: GatewayConfig) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(t("title"));
		const content = new DocumentFragment();
		const target = content.createDiv();
		this.setContent(content);
		this.stack.adopt(
			mount(GatewayOptionsEditor, {
				target,
				props: {
					config: this.config,
					updateConfig: this.updateConfig,
				},
			}),
			(i) => void unmount(i),
		);
	}

	onClose(): void {
		this.stack.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		title: "Gateway Options",
	},
	zh: {
		title: "网关选项",
	},
});
//#endregion

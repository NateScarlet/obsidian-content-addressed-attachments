import { Modal, type App } from "obsidian";
import type { HeaderRule } from "#src/URLResolver";
import { mount, unmount } from "svelte";
import HeaderRuleOptionsEditor from "#src/lib/HeaderRuleOptionsEditor.svelte";
import defineLocales from "#src/utils/defineLocales";

export default class HeaderRuleOptionsModal extends Modal {
	private stack = new DisposableStack();

	constructor(
		app: App,
		private config: HeaderRule,
		private updateConfig: (v: HeaderRule) => void,
		private deleteConfig: () => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(t("title"));
		const content = new DocumentFragment();
		const target = content.createDiv();
		this.setContent(content);
		this.stack.adopt(
			mount(HeaderRuleOptionsEditor, {
				target,
				props: {
					config: this.config,
					updateConfig: this.updateConfig,
					deleteConfig: () => {
						this.deleteConfig();
						this.close();
					},
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
		title: "Header rule options",
	},
	zh: {
		title: "请求头规则选项",
	},
});
//#endregion

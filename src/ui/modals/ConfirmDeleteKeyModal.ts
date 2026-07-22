import { Modal, Setting, type App } from "obsidian";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		confirmDeleteKeyTitle: "Confirm delete key",
		confirmDeleteKeyDesc: (name: string, fp: string) =>
			`Deleting key "${name}" (${fp}) will permanently lose access to files encrypted with it. Continue?`,
		cancel: "Cancel",
		delete: "Delete",
	},
	zh: {
		confirmDeleteKeyTitle: "确认删除密钥",
		confirmDeleteKeyDesc: (name: string, fp: string) =>
			`密钥 "${name}" (${fp}) 删除后将无法解密以此密钥加密的文件。确定要删除吗？`,
		cancel: "取消",
		delete: "删除",
	},
});

export class ConfirmDeleteKeyModal extends Modal {
	constructor(
		app: App,
		private keyName: string,
		private keyFingerprint: string,
		private onDelete: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("confirmDeleteKeyTitle") });
		contentEl.createEl("p", {
			text: t("confirmDeleteKeyDesc")(this.keyName, this.keyFingerprint),
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("cancel")).onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("delete"))
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setWarning()
					.onClick(() => {
						this.onDelete();
						this.close();
					}),
			);
	}
}

import { Modal, Setting, type App } from "obsidian";
import type { KeyManager } from "#src/lib/encryption/KeyManager";
import showError from "#src/utils/showError";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		renameKeyTitle: "Rename key",
		keyNameLabel: "Key name",
		keyNamePlaceholder: "Enter key name",
		cancel: "Cancel",
		save: "Save",
	},
	zh: {
		renameKeyTitle: "重命名密钥",
		keyNameLabel: "密钥名称",
		keyNamePlaceholder: "输入密钥名称",
		cancel: "取消",
		save: "保存",
	},
});

export class RenameKeyModal extends Modal {
	private nameInput!: HTMLInputElement;

	constructor(
		app: App,
		private keyManager: KeyManager,
		private fingerprint: string,
		private currentName: string,
		private defaultDisplayName: string,
		private onSave: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("renameKeyTitle") });

		new Setting(contentEl).setName(t("keyNameLabel")).addText((text) => {
			text.setPlaceholder(this.defaultDisplayName);
			text.setValue(this.currentName || this.defaultDisplayName);
			this.nameInput = text.inputEl;
			this.nameInput.select();
			this.nameInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					void this.submit();
				}
			});
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("cancel")).onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("save"))
					.setCta()
					.onClick(() => void this.submit()),
			);
	}

	private async submit() {
		const newName = this.nameInput.value.trim();
		try {
			await this.keyManager.renameKey(this.fingerprint, newName);
			await this.onSave();
			this.close();
		} catch (err) {
			showError(err);
		}
	}
}

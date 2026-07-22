import { Modal, Setting, Notice, type App } from "obsidian";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import showError from "#src/utils/showError";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		keyExportTitle: "Export keys",
		keyExportDesc:
			"Enter a passphrase to encrypt the exported keys. You will need this passphrase to import them on another device.",
		keyPassphraseLabel: "Passphrase",
		keyPassphrasePlaceholder: "Enter passphrase",
		cancel: "Cancel",
		exportAllKeys: "Export all keys",
		exportAllKeysSuccess: "All keys copied to clipboard",
	},
	zh: {
		keyExportTitle: "导出密钥",
		keyExportDesc:
			"请输入口令对导出的密钥进行加密。在其他设备上导入时需要此口令。",
		keyPassphraseLabel: "口令",
		keyPassphrasePlaceholder: "输入口令",
		cancel: "取消",
		exportAllKeys: "导出所有密钥",
		exportAllKeysSuccess: "所有密钥已复制到剪贴板",
	},
});

export class ExportKeysModal extends Modal {
	private passphraseInput!: HTMLInputElement;

	constructor(
		app: App,
		private encryptionService: EncryptionService,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("keyExportTitle") });
		contentEl.createEl("p", { text: t("keyExportDesc") });

		new Setting(contentEl)
			.setName(t("keyPassphraseLabel"))
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder(t("keyPassphrasePlaceholder"));
				this.passphraseInput = text.inputEl;
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("cancel")).onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("exportAllKeys"))
					.setCta()
					.onClick(async () => {
						const passphrase = this.passphraseInput.value;
						if (!passphrase) return;
						try {
							const encrypted =
								await this.encryptionService.exportAllKeys(
									passphrase,
								);
							await navigator.clipboard.writeText(encrypted);
							new Notice(t("exportAllKeysSuccess"));
							this.close();
						} catch (err) {
							showError(err);
						}
					}),
			);
	}
}

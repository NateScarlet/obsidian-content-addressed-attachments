import { Modal, Setting, Notice, type App } from "obsidian";
import type { KeyManager } from "#src/lib/encryption/KeyManager";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		keyImportTitle: "Import key",
		keyImportDesc:
			"Paste a key from another device to access encrypted files synced to this vault.",
		keyImportReadingClipboard: "Reading clipboard…",
		keyImportClipboardOk: "Encrypted key data found in clipboard.",
		keyImportClipboardInvalid:
			"Clipboard does not contain valid key backup data.",
		keyImportClipboardUnavailable:
			"Cannot read clipboard. Copy the backup data first.",
		keyPassphraseLabel: "Passphrase",
		keyPassphrasePlaceholder: "Enter passphrase",
		cancel: "Cancel",
		importKeys: "Import keys from backup",
		keyImportSuccess: (count: number) =>
			count > 0 ? `Imported ${count} key(s)` : "No new keys to import",
		keyImportErrorInvalid: "Wrong passphrase or invalid backup data",
	},
	zh: {
		keyImportTitle: "导入密钥",
		keyImportDesc:
			"粘贴从其他设备导出的密钥备份数据，以解密同步到此库的加密文件。",
		keyImportReadingClipboard: "正在读取剪贴板…",
		keyImportClipboardOk: "从剪贴板中识别到加密密钥数据。",
		keyImportClipboardInvalid: "剪贴板内容非有效的密钥备份数据。",
		keyImportClipboardUnavailable: "无法读取剪贴板，请先复制备份数据。",
		keyPassphraseLabel: "口令",
		keyPassphrasePlaceholder: "输入口令",
		cancel: "取消",
		importKeys: "从备份导入密钥",
		keyImportSuccess: (count: number) =>
			count > 0 ? `成功导入 ${count} 个密钥` : "没有新的密钥被导入",
		keyImportErrorInvalid: "口令错误或备份数据无效",
	},
});

export class ImportKeysModal extends Modal {
	private passphraseInput!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private encryptedData = "";

	constructor(
		app: App,
		private keyManager: KeyManager,
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("keyImportTitle") });
		contentEl.createEl("p", { text: t("keyImportDesc") });

		this.statusEl = contentEl.createEl("p", {
			text: t("keyImportReadingClipboard"),
		});

		try {
			const text = await navigator.clipboard.readText();
			const parsed = JSON.parse(text) as {
				salt?: unknown;
				iv?: unknown;
				data?: unknown;
			};
			if (parsed?.salt && parsed?.iv && parsed?.data) {
				this.encryptedData = text;
				this.statusEl.textContent = t("keyImportClipboardOk");
			} else {
				this.statusEl.textContent = t("keyImportClipboardInvalid");
			}
		} catch {
			this.statusEl.textContent = t("keyImportClipboardUnavailable");
		}

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
					.setButtonText(t("importKeys"))
					.setCta()
					.onClick(async () => {
						const passphrase = this.passphraseInput.value;
						if (!this.encryptedData || !passphrase) return;
						try {
							const count = await this.keyManager.importAllKeys(
								this.encryptedData,
								passphrase,
							);
							new Notice(t("keyImportSuccess")(count));
							this.close();
						} catch {
							new Notice(t("keyImportErrorInvalid"));
						}
					}),
			);
	}
}

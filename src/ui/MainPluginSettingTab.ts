import { PluginSettingTab, Setting, Notice, Modal, type App } from "obsidian";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";
import GatewayOptionsModal from "./GatewayOptionsModal";
import clsx from "clsx";
import TemplateSyntaxHelp from "#src/lib/TemplateSyntaxHelp.svelte";
import TemplatePreview from "#src/lib/TemplatePreview.svelte";
import EncryptionSettingsComponent from "#src/lib/EncryptionSettings.svelte";
import { mount, unmount } from "svelte";
import showError from "#src/utils/showError";
import ignore from "ignore";
import type { KeyManager } from "#src/lib/encryption/KeyManager";
import { mdiUndo } from "@mdi/js";
import showButton from "#src/utils/showButton";

export default class MainPluginSettingTab extends PluginSettingTab {
	private stack?: DisposableStack;

	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 清理之前的组件
		this.stack?.dispose();
		const stack = new DisposableStack();
		this.stack = stack;

		new Setting(containerEl)
			.setName(t("primaryStorageDirectory"))
			.setDesc(t("primaryStorageDirectoryDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("examplePlaceholder"))
					.setValue(this.plugin.settings.primaryDir)
					.onChange(async (value) => {
						this.plugin.settings.primaryDir = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName(t("downloadDirectory"))
			.setDesc(t("downloadDirectoryDesc"))
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.primaryDir)
					.setValue(this.plugin.settings.downloadDir)
					.onChange(async (value) => {
						this.plugin.settings.downloadDir = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("gateways"))
			.setDesc(t("gatewaysDesc"))
			.addButton((button) =>
				button
					.setIcon("house-plus")
					.setTooltip(t("addGateway"))
					.onClick(async () => {
						this.plugin.settings.gateways.push({
							name: t("newGateway"),
							urlTemplate:
								"https://example.com/{{cid}}{{{url.pathname}}}",
							headers: [],
							enabled: true,
						});
						await this.plugin.saveSettings();
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						this.display();
					}),
			);

		// 创建模板预览组件
		const previewContainer = containerEl.createDiv();
		const preview = stack.adopt(
			mount(TemplatePreview, {
				target: previewContainer,
				props: {
					urlResolver: this.plugin.urlResolver,
				},
			}),
			(i) => void unmount(i),
		);

		this.plugin.settings.gateways.forEach((config, index) => {
			const setting = new Setting(containerEl)
				.setName("")
				.setDesc("")
				.addToggle((toggle) =>
					toggle.setValue(config.enabled).onChange(async (value) => {
						config.enabled = value;
						await this.plugin.saveSettings();
					}),
				)
				.addText((text) => {
					text.setPlaceholder(t("configurationName"))
						.setValue(config.name)
						.onChange(async (value) => {
							config.name = value;
							await this.plugin.saveSettings();
						});
					text.inputEl.className = clsx`min-w-32 max-w-full flex-1 grow`;
				})
				.addText((text) => {
					const input = text
						.setPlaceholder(t("urlTemplate"))
						.setValue(config.urlTemplate)
						.onChange(async (value) => {
							config.urlTemplate = value;
							await this.plugin.saveSettings();
							preview.config = config;
						});

					input.inputEl.className = clsx`flex-1/2 max-w-full grow`;

					input.inputEl.addEventListener("focus", () => {
						preview.config = config;
					});
					return input;
				})
				.addExtraButton((button) => {
					button
						.setIcon("settings")
						.setTooltip(t("gatewayOptions"))
						.onClick(() => {
							const modal = new GatewayOptionsModal(
								this.app,
								config,
								(config) => {
									this.plugin.settings.gateways[index] =
										config;
									this.plugin.saveSettings().catch(showError);
									// eslint-disable-next-line @typescript-eslint/no-deprecated
									this.display();
								},
								() => {
									modal.close();
									const delayMs = 5e3;
									let cancelled = false;
									const close = showButton({
										message: t("willDeleteGateway")(
											config.name,
										),
										icon: {
											pathData: mdiUndo,
										},
										label: t("undo"),
										onclick: () => {
											cancelled = true;
										},
									});
									window.setTimeout(() => {
										close();
										if (cancelled) {
											return;
										}
										this.plugin.settings.gateways.splice(
											index,
											1,
										);
										this.plugin
											.saveSettings()
											.catch(showError);
										// eslint-disable-next-line @typescript-eslint/no-deprecated
										this.display();
									}, delayMs);
								},
							);
							modal.open();
						});
					button.extraSettingsEl.className = clsx({
						"text-accent": config.headers.length > 0,
					});
					return button;
				});

			const control = setting.settingEl.querySelector(
				".setting-item-control",
			);
			if (control instanceof HTMLElement) {
				control.className = clsx(control.className, "flex-wrap");
			}
			const info = setting.settingEl.querySelector(".setting-item-info");
			if (info instanceof HTMLElement) {
				info.className = clsx`hidden`;
			}
		});

		// 创建模板语法帮助组件
		const helpContainer = containerEl.createDiv();
		this.stack.adopt(
			mount(TemplateSyntaxHelp, {
				target: helpContainer,
			}),
			(i) => void unmount(i),
		);

		// 全库操作区域
		new Setting(containerEl).setName(t("advancedOperations")).setHeading();

		new Setting(containerEl)
			.setName(t("migrateAllNotes"))
			.setDesc(t("migrateAllNotesDesc"))
			.addButton((button) =>
				button.setButtonText(t("execute")).onClick(() => {
					this.plugin.migrationManager
						.execute("all")
						.catch(showError);
				}),
			);

		new Setting(containerEl)
			.setName(t("lockAllNotes"))
			.setDesc(t("lockAllNotesDesc"))
			.addButton((button) =>
				button.setButtonText(t("execute")).onClick(() => {
					this.plugin.lockManager.execute("all").catch(showError);
				}),
			);

		//#region 加密设置
		if (this.plugin.encryptionService?.isAvailable) {
			new Setting(containerEl).setName(t("encryption")).setHeading();

			const target = containerEl.createDiv();
			this.stack.adopt(
				mount(EncryptionSettingsComponent, {
					target,
					props: {
						encryptionService: this.plugin.encryptionService,
						settings: this.plugin.settings,
						saveSettings: () => this.plugin.saveSettings(),
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						display: () => this.display(),
						app: this.app,
						RenameKeyModal,
						ConfirmDeleteKeyModal,
						ExportKeysModal,
						ImportKeysModal,
						onEncryptMatchingNotes: async (
							keyFingerprint: string,
							pattern: string,
						) => {
							const { encryptNote } = await import(
								"#src/commands/convertAttachment"
							);
							const files = this.app.vault.getMarkdownFiles();
							let total = 0;
							for (const file of files) {
								if (ignore().add(pattern).ignores(file.path)) {
									const count = await encryptNote(
										this.app,
										this.plugin.cas,
										this.plugin.encryptionService,
										file,
										keyFingerprint,
										this.plugin.settings.primaryDir,
									);
									total += count;
								}
							}
							new Notice(`Encrypted ${total} link(s)`);
						},
					},
				}),
				(instance) => void unmount(instance),
			);
		} else {
			new Setting(containerEl).setName(t("encryption")).setHeading();
			new Setting(containerEl)
				.setName(t("encryptionUnavailable"))
				.setDesc(t("encryptionUnavailableDesc"));
		}
		//#endregion
	}

	onClose(): void {
		this.stack?.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		primaryStorageDirectory: "Primary storage directory",
		primaryStorageDirectoryDesc:
			"Newly added attachments will be stored in this directory",
		downloadDirectory: "Download directory",
		downloadDirectoryDesc:
			"Downloaded file will be stored in this directory",
		gateways: "Gateways",
		gatewaysDesc:
			"Used to fetch files not available locally, defined using Mustache template syntax. If the URL is empty, only read existing files from the download directory (set in options)",
		addGateway: "Add gateway",
		gatewayOptions: "Gateway options",
		willDeleteGateway: (name: string) => `Will delete gateway '${name}'`,
		newGateway: "New gateway",
		undo: "Undo",
		configurationName: "Configuration name",
		urlTemplate: "URL template (Mustache syntax)",
		examplePlaceholder: "e.g. .attachments/cas",
		advancedOperations: "Advanced operations",
		migrateAllNotes: "Migrate local files (all notes)",
		migrateAllNotesDesc:
			"Migrate all local file links in all notes to IPFS links",
		lockAllNotes: "Lock web files (all notes)",
		lockAllNotesDesc:
			"Download and lock all external web file links in all notes",
		restoreReferencedFiles: "Restore referenced files",
		restoreReferencedFilesDesc:
			"Restore files that are still referenced but were deleted to the recycle bin",
		execute: "Execute",
		noReferencedFilesToRestore:
			"No referenced files to restore from the recycle bin.",
		encryption: "Encryption",
		encryptionUnavailable: "Encryption unavailable",
		encryptionUnavailableDesc:
			"Encryption requires Obsidian v1.11.4+. Please upgrade Obsidian to use this feature.",
		createNewKey: "Create new key",
		create: "Create",
		keyExportSuccess: "Key copied to clipboard",
		keyCreateSuccess: (name: string) => `Key "${name}" created`,
		keyNamePlaceholder: "Key name",
		unnamedKey: "Unnamed key",
		confirmDeleteKeyTitle: "Confirm delete key",
		confirmDeleteKeyDesc: (name: string, fp: string) =>
			`Deleting key "${name}" (${fp}) will permanently lose access to files encrypted with it. Continue?`,
		cancel: "Cancel",
		delete: "Delete",
		exportKey: "Backup key",
		rename: "Rename",
		importKeys: "Import keys from backup",
		exportAllKeys: "Export all keys",
		exportAllKeysSuccess: "All keys copied to clipboard",
		keyExportTitle: "Export keys",
		keyExportDesc:
			"Enter a passphrase to encrypt the exported keys. You will need this passphrase to import them on another device.",
		keyPassphraseLabel: "Passphrase",
		keyPassphrasePlaceholder: "Enter passphrase",
		fingerprint: "Fingerprint",
		keyEditTitle: "Edit key",
		keyNameLabel: "Name",
		keyRenamePlaceholder: "New name",
		keyRenameSuccess: (name: string) => `Key renamed to "${name}"`,
		keyImportTitle: "Import key",
		keyImportDesc:
			"Paste a key from another device to access encrypted files synced to this vault.",
		keyImportReadingClipboard: "Reading clipboard…",
		keyImportClipboardOk: "Encrypted key data found in clipboard.",
		keyImportClipboardInvalid:
			"Clipboard does not contain valid key backup data.",
		keyImportClipboardUnavailable:
			"Cannot read clipboard. Copy the backup data first.",
		keyImportSuccess: (count: number) =>
			count > 0 ? `Imported ${count} key(s)` : "No new keys to import",
		keyImportErrorInvalid: "Wrong passphrase or invalid backup data",
	},
	zh: {
		primaryStorageDirectory: "主存储目录",
		primaryStorageDirectoryDesc: "存储新添加的附件",
		downloadDirectory: "下载目录",
		downloadDirectoryDesc: "存储从网络下载文件",
		gateways: "网关",
		gatewaysDesc:
			"用于获取本地缺少的文件，使用 Mustache 模板语法定义 URL 格式。如果网址为空，则仅从下载目录（选项中设置）读取已有文件",
		addGateway: "添加网关",
		gatewayOptions: "网关选项",
		undo: "撤销",
		willDeleteGateway: (name: string) => `将删除网关 '${name}'`,
		newGateway: "新网关",
		configurationName: "配置名称",
		urlTemplate: "URL模板（Mustache语法）",
		examplePlaceholder: "例如: .attachments/cas",
		advancedOperations: "高级操作",
		migrateAllNotes: "迁移本地文件（所有笔记）",
		migrateAllNotesDesc: "将所有笔记中的本地文件链接迁移为 IPFS 链接",
		lockAllNotes: "锁定网络文件（所有笔记）",
		lockAllNotesDesc: "下载并锁定所有笔记中的外部网络文件链接",
		restoreReferencedFiles: "恢复被引用的文件",
		restoreReferencedFilesDesc: "恢复仍在被引用但已被删除到回收站的文件",
		execute: "执行",
		noReferencedFilesToRestore: "未发现回收站中有需要恢复的引用文件。",
		encryption: "加密",
		encryptionUnavailable: "加密不可用",
		encryptionUnavailableDesc:
			"加密功能需要 Obsidian v1.11.4+。请升级 Obsidian 以使用此功能。",
		createNewKey: "创建新密钥",
		create: "创建",
		keyExportSuccess: "密钥已复制到剪贴板",
		keyCreateSuccess: (name: string) => `密钥 "${name}" 已创建`,
		keyNamePlaceholder: "密钥名称",
		unnamedKey: "未命名密钥",
		confirmDeleteKeyTitle: "确认删除密钥",
		confirmDeleteKeyDesc: (name: string, fp: string) =>
			`密钥 "${name}" (${fp}) 删除后将无法解密以此密钥加密的文件。确定要删除吗？`,
		cancel: "取消",
		delete: "删除",
		exportKey: "备份密钥",
		rename: "重命名",
		importKeys: "从备份导入密钥",
		exportAllKeys: "导出全部密钥",
		exportAllKeysSuccess: "全部密钥已复制到剪贴板",
		keyExportTitle: "导出密钥",
		keyExportDesc:
			"输入口令加密导出的密钥数据。导入到另一台设备时需要同一口令。",
		keyPassphraseLabel: "口令",
		keyPassphrasePlaceholder: "输入口令",
		fingerprint: "指纹",
		keyEditTitle: "编辑密钥",
		keyNameLabel: "名称",
		keyRenamePlaceholder: "新名称",
		keyRenameSuccess: (name: string) => `密钥已重命名为 "${name}"`,
		keyImportTitle: "导入密钥",
		keyImportDesc: "从另一台设备粘贴密钥，以访问该库中已加密的文件。",
		keyImportReadingClipboard: "正在读取剪贴板…",
		keyImportClipboardOk: "剪贴板中已检测到加密的密钥备份数据。",
		keyImportClipboardInvalid: "剪贴板中未找到有效的密钥备份数据。",
		keyImportClipboardUnavailable: "无法读取剪贴板。请先复制备份数据。",
		keyImportSuccess: (count: number) =>
			count > 0 ? `已导入 ${count} 个密钥` : "没有需要导入的新密钥",
		keyImportErrorInvalid: "口令错误或备份数据无效",
	},
});
//#endregion

export class RenameKeyModal extends Modal {
	constructor(
		app: App,
		private fingerprint: string,
		private currentName: string,
		private keyManager: KeyManager,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("keyEditTitle") });

		let input: HTMLInputElement;
		new Setting(contentEl).setName(t("keyNameLabel")).addText((text) => {
			text.setPlaceholder(t("keyRenamePlaceholder"));
			text.setValue(this.currentName);
			input = text.inputEl;
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("cancel")).onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("rename"))
					.setCta()
					.onClick(async () => {
						const newName = input.value?.trim() || this.currentName;
						await this.keyManager.renameKey(
							this.fingerprint,
							newName,
						);
						new Notice(t("keyRenameSuccess")(newName));
						this.close();
					}),
			);
	}
}

export class ExportKeysModal extends Modal {
	private passphraseInput!: HTMLInputElement;

	constructor(
		app: App,
		private keyManager: KeyManager,
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
								await this.keyManager.exportAllKeys(passphrase);
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

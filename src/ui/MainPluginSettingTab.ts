import { PluginSettingTab, Setting, Notice } from "obsidian";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";
import GatewayOptionsModal from "./GatewayOptionsModal";
import HeaderRuleOptionsModal from "./HeaderRuleOptionsModal";
import ExportKeysModal from "./modals/ExportKeysModal";
import ImportKeysModal from "./modals/ImportKeysModal";
import clsx from "clsx";
import TemplateSyntaxHelp from "#src/lib/TemplateSyntaxHelp.svelte";
import TemplatePreview from "#src/lib/TemplatePreview.svelte";
import EncryptionSettingsComponent from "#src/lib/EncryptionSettings.svelte";
import PreProcessScriptInput from "#src/lib/PreProcessScriptInput.svelte";
import { mount, unmount } from "svelte";
import showError from "#src/utils/showError";
import { encryptNote } from "#src/commands/convertAttachment";
import {
	createReprocessContext,
	reprocessWholeVault,
} from "#src/commands/reprocessAttachments";
import { findScriptByURL, SCRIPT_INDEX } from "#src/preprocess/scriptIndex";
import ignore from "ignore";
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

		//#region 请求头规则：按 baseUrl 前缀匹配任意远程请求并附加请求头
		new Setting(containerEl)
			.setName(t("headerRules"))
			.setDesc(t("headerRulesDesc"))
			.addButton((button) =>
				button
					.setIcon("plus")
					.setTooltip(t("addHeaderRule"))
					.onClick(async () => {
						this.plugin.settings.headerRules.push({
							baseUrl: "",
							headers: [],
						});
						await this.plugin.saveSettings();
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						this.display();
					}),
			);

		this.plugin.settings.headerRules.forEach((rule, index) => {
			const setting = new Setting(containerEl)
				.setName("")
				.setDesc("")
				.addText((text) => {
					text.setPlaceholder(t("headerRuleBaseUrlPlaceholder"))
						.setValue(rule.baseUrl)
						.onChange(async (value) => {
							rule.baseUrl = value;
							await this.plugin.saveSettings();
						});
					text.inputEl.className = clsx`min-w-32 max-w-full flex-1 grow`;
				})
				.addExtraButton((button) => {
					button
						.setIcon("settings")
						.setTooltip(t("headerRuleOptions"))
						.onClick(() => {
							const modal = new HeaderRuleOptionsModal(
								this.app,
								rule,
								(updated) => {
									this.plugin.settings.headerRules[index] =
										updated;
									this.plugin.saveSettings().catch(showError);
									// eslint-disable-next-line @typescript-eslint/no-deprecated
									this.display();
								},
								() => {
									modal.close();
									const delayMs = 5e3;
									let cancelled = false;
									const close = showButton({
										message: t("willDeleteHeaderRule")(
											rule.baseUrl || t("unnamedRule"),
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
										this.plugin.settings.headerRules.splice(
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
						"text-accent": rule.headers.length > 0,
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
		//#endregion

		// 创建模板语法帮助组件
		const helpContainer = containerEl.createDiv();
		this.stack.adopt(
			mount(TemplateSyntaxHelp, {
				target: helpContainer,
			}),
			(i) => void unmount(i),
		);

		//#region 加密设置
		if (this.plugin.hasSecretStorage) {
			new Setting(containerEl).setName(t("encryption")).setHeading();

			const target = containerEl.createDiv();
			this.stack.adopt(
				mount(EncryptionSettingsComponent, {
					target,
					props: {
						keyManager: this.plugin.keyManager,
						encryptionService: this.plugin.encryptionService,
						settings: this.plugin.settings,
						saveSettings: () => this.plugin.saveSettings(),
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						display: () => this.display(),
						app: this.app,
						ExportKeysModal,
						ImportKeysModal,
						onEncryptMatchingNotes: async (pattern: string) => {
							const trimmedPattern = pattern.trim();
							if (!trimmedPattern) {
								new Notice(t("noMatchingFiles"));
								return;
							}
							const patterns = trimmedPattern
								.split("\n")
								.map((s) => s.trim())
								.filter((s) => s && !s.startsWith("#"));

							if (patterns.length === 0) {
								new Notice(t("noMatchingFiles"));
								return;
							}

							const files = this.app.vault.getMarkdownFiles();
							let total = 0;
							const ig = ignore().add(patterns);
							const ctx = {
								app: this.app,
								cas: this.plugin.cas,
								encryptionService:
									this.plugin.encryptionService,
								urlResolver: this.plugin.urlResolver,
								referenceManager: this.plugin.referenceManager,
								dir: this.plugin.settings.primaryDir,
								keyManager: this.plugin.keyManager,
								encryptPathPolicy:
									this.plugin.encryptPathPolicy,
							};
							for (const file of files) {
								if (ig.ignores(file.path)) {
									const count = await encryptNote(
										ctx,
										file,
										this.plugin.settings.primaryDir,
									);
									total += count;
								}
							}
							new Notice(t("encryptMatchingNotesSuccess")(total));
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

		//#region 预处理设置
		new Setting(containerEl).setName(t("preProcessing")).setHeading();

		// 预处理脚本：多行输入框（支持长 URL 换行）+ 预设自动补全下拉
		const currentScriptURL = this.plugin.settings.preProcess.scriptURL;
		const scriptInputContainer = containerEl.createDiv();
		this.stack.adopt(
			mount(PreProcessScriptInput, {
				target: scriptInputContainer,
				props: {
					value: currentScriptURL || "",
					entries: SCRIPT_INDEX,
					customScriptLabel: t("customScript"),
					disabledLabel: t("preProcessDisabled"),
					findScriptByURL,
					onChange: async (value: string) => {
						this.plugin.settings.preProcess.scriptURL = value;
						await this.plugin.saveSettings();
					},
				},
			}),
			(i) => void unmount(i),
		);
		//#endregion

		// 全库操作区域
		new Setting(containerEl).setName(t("advancedOperations")).setHeading();

		const btnText = t("execute");

		new Setting(containerEl)
			.setName(t("migrateAllNotes"))
			.setDesc(t("migrateAllNotesDesc"))
			.addButton((button) =>
				button.setButtonText(btnText).onClick(() => {
					this.plugin.migrationManager
						.execute("all")
						.catch(showError);
				}),
			);

		new Setting(containerEl)
			.setName(t("lockAllNotes"))
			.setDesc(t("lockAllNotesDesc"))
			.addButton((button) => {
				button.setButtonText(btnText).onClick(() => {
					this.plugin.lockManager.execute("all").catch(showError);
				});
			});

		new Setting(containerEl)
			.setName(t("reprocessWholeVault"))
			.setDesc(t("reprocessWholeVaultDesc"))
			.addButton((button) =>
				button.setButtonText(btnText).onClick(() => {
					reprocessWholeVault(
						createReprocessContext(this.plugin),
					).catch(showError);
				}),
			);
	}

	onClose(): void {
		this.stack?.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		primaryStorageDirectory: "Primary storage directory",
		primaryStorageDirectoryDesc: "Directory for new attachments",
		downloadDirectory: "Download directory",
		downloadDirectoryDesc: "Directory for files downloaded from the web",
		gateways: "Gateways",
		gatewaysDesc:
			"Used to fetch missing local files, using Mustache template syntax. If empty, only existing files from the download directory will be read.",
		addGateway: "Add gateway",
		gatewayOptions: "Gateway options",
		willDeleteGateway: (name: string) => `Will delete gateway '${name}'`,
		newGateway: "New gateway",
		undo: "Undo",
		configurationName: "Configuration name",
		urlTemplate: "URL template (Mustache syntax)",
		headerRules: "Request header rules",
		headerRulesDesc:
			"Headers applied to every remote request whose URL starts with the given base URL. Useful for authenticated source/gateway endpoints.",
		addHeaderRule: "Add rule",
		headerRuleBaseUrlPlaceholder: "e.g. https://source.example.com",
		headerRuleOptions: "Header rule options",
		willDeleteHeaderRule: (baseUrl: string) =>
			`Will delete header rule '${baseUrl}'`,
		unnamedRule: "Unnamed rule",
		examplePlaceholder: "e.g. .attachments/cas",
		advancedOperations: "Advanced operations",
		migrateAllNotes: "Migrate local files (all notes)",
		migrateAllNotesDesc:
			"Migrate all local file links in all notes to IPFS links",
		lockAllNotes: "Lock web files (all notes)",
		lockAllNotesDesc:
			"Download and lock all external web file links in all notes",
		execute: "Execute",
		encryption: "Encryption",
		encryptionUnavailable: "Encryption unavailable",
		encryptionUnavailableDesc:
			"Encryption requires Obsidian v1.11.4+. Please upgrade Obsidian to use this feature.",
		encryptMatchingNotesSuccess: (count: number) =>
			`Encrypted ${count} link(s)`,
		noMatchingFiles: "No matching notes found for rule",
		reprocessWholeVault:
			"Reprocess all attachments (whole vault, advanced)",
		reprocessWholeVaultDesc:
			"Reprocess all referenced attachments using the pre-processing pipeline",
		preProcessing: "Pre-processing",
		preProcessDisabled: "Disabled",
		customScript: "Custom script",
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
		headerRules: "请求头规则",
		headerRulesDesc:
			"为 URL 以指定 Base URL 开头的所有远程请求附加请求头，适用于需要认证的源站或网关",
		addHeaderRule: "添加规则",
		headerRuleBaseUrlPlaceholder: "例如: https://source.example.com",
		headerRuleOptions: "请求头规则选项",
		willDeleteHeaderRule: (baseUrl: string) =>
			`将删除请求头规则 '${baseUrl}'`,
		unnamedRule: "未命名规则",
		examplePlaceholder: "例如: .attachments/cas",
		advancedOperations: "高级操作",
		migrateAllNotes: "迁移本地文件（所有笔记）",
		migrateAllNotesDesc: "将所有笔记中的本地文件链接迁移为 IPFS 链接",
		lockAllNotes: "锁定网络文件（所有笔记）",
		lockAllNotesDesc: "下载并锁定所有笔记中的外部网络文件链接",
		execute: "执行",
		encryption: "加密",
		encryptionUnavailable: "加密不可用",
		encryptionUnavailableDesc:
			"加密功能需要 Obsidian v1.11.4+。请升级 Obsidian 以使用此功能。",
		encryptMatchingNotesSuccess: (count: number) =>
			`已加密 ${count} 个链接`,
		noMatchingFiles: "未找到符合路径规则的笔记",
		reprocessWholeVault: "重新处理所有附件（全库，高级操作）",
		reprocessWholeVaultDesc: "使用预处理管线重新处理所有被引用的附件",
		preProcessing: "预处理",
		preProcessDisabled: "禁用",
		customScript: "自定义脚本",
	},
});
//#endregion

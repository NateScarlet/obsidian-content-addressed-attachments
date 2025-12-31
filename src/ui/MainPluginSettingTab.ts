import { PluginSettingTab, Setting } from "obsidian";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";
import GatewayOptionsModal from "./GatewayOptionsModal";
import clsx from "clsx";
import TemplateSyntaxHelp from "src/lib/TemplateSyntaxHelp.svelte";
import TemplatePreview from "src/lib/TemplatePreview.svelte";
import { mount, unmount } from "svelte";
import showError from "src/utils/showError";
import { mdiUndo } from "@mdi/js";
import showButton from "src/utils/showButton";

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
									setTimeout(() => {
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
	}

	onClose(): void {
		this.stack?.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		primaryStorageDirectory: "Primary Storage Directory",
		primaryStorageDirectoryDesc:
			"Newly added attachments will be stored in this directory",
		downloadDirectory: "Download Directory",
		downloadDirectoryDesc:
			"Downloaded file will be stored in this directory",
		gateways: "Gateways",
		gatewaysDesc:
			"Used to fetch files not available locally, defined using Mustache template syntax. If the URL is empty, only read existing files from the download directory (set in options)",
		addGateway: "Add Gateway",
		gatewayOptions: "Gateway Options",
		willDeleteGateway: (name: string) => `Will delete gateway '${name}'`,
		newGateway: "New Gateway",
		undo: "Undo",
		configurationName: "Configuration Name",
		urlTemplate: "URL Template (Mustache syntax)",
		examplePlaceholder: "e.g. .attachments/cas",
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
	},
});
//#endregion

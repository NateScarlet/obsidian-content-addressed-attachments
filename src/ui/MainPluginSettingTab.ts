import { PluginSettingTab, Setting } from "obsidian";
import type ContentAddressedAttachmentPlugin from "../main";
import defineLocales from "../utils/defineLocales";
import HeadersEditModal from "./HeadersEditModal";
import clsx from "clsx";
import TemplateSyntaxHelp from "./TemplateSyntaxHelp.svelte";
import TemplatePreview from "./TemplatePreview.svelte";
import { mount, unmount } from "svelte";
import showError from "src/utils/showError";

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
			.setName(t("localStorage"))
			.setDesc(t("localStorageDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("examplePlaceholder"))
					.setValue(this.plugin.settings.casDir)
					.onChange(async (value) => {
						this.plugin.settings.casDir = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("externalStorage"))
			.setDesc(t("externalStorageDesc"))
			.addButton((button) =>
				button
					.setButtonText(t("addExternalStorage"))
					.onClick(async () => {
						this.plugin.settings.gatewayURLs.push({
							name: t("newExternalStorage"),
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

		this.plugin.settings.gatewayURLs.forEach((config, index) => {
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
						.setTooltip(t("editHeaders"))
						.onClick(() => {
							new HeadersEditModal(
								this.app,
								config,
								(newHeaders) => {
									config.headers = newHeaders;
									this.plugin.saveSettings().catch(showError);
									this.display();
								},
							).open();
						});
					button.extraSettingsEl.className = clsx({
						"text-accent": config.headers.length > 0,
					});
					return button;
				})
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip(t("delete"))
						.onClick(async () => {
							this.plugin.settings.gatewayURLs.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						}),
				);

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
		localStorage: "Local Storage",
		localStorageDesc:
			"Local directory path for storing content-addressed attachments",
		externalStorage: "External Storage",
		externalStorageDesc:
			"Used to fetch files not available locally, defined using Mustache template syntax",
		addExternalStorage: "Add External Storage",
		editHeaders: "Edit Headers",
		delete: "Delete",
		newExternalStorage: "New External Storage",
		configurationName: "Configuration Name",
		urlTemplate: "URL Template (Mustache syntax)",
		close: "Close",
		examplePlaceholder: "e.g. .attachments/cas",
	},
	zh: {
		localStorage: "本地存储",
		localStorageDesc: "用于存储内容寻址附件的本地目录路径",
		externalStorage: "外部存储",
		externalStorageDesc:
			"用于获取本地缺少的文件，使用 Mustache 模板语法定义 URL 格式",
		addExternalStorage: "添加外部存储",
		editHeaders: "编辑请求头",
		delete: "删除",
		newExternalStorage: "新外部存储",
		configurationName: "配置名称",
		urlTemplate: "URL模板（Mustache语法）",
		close: "关闭",
		examplePlaceholder: "例如: .attachments/cas",
	},
});
//#endregion

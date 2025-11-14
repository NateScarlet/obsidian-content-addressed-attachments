import {
	PluginSettingTab,
	Setting,
	Modal,
	TextAreaComponent,
	type App,
} from "obsidian";
import type ContentAddressedAttachmentPlugin from "./main";
import defineLocales from "./utils/defineLocales";
import type { GatewayURLConfig } from "./main";

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
		templateSyntaxHelp: "Template Syntax Help",
		editHeaders: "Edit Headers",
		delete: "Delete",
		newExternalStorage: "New External Storage",
		configurationName: "Configuration Name",
		urlTemplate: "URL Template (Mustache syntax)",
		close: "Close",
		save: "Save",
		cancel: "Cancel",
		examplePlaceholder: "e.g. .attachments/cas",
		headersDescription:
			"One header per line, format: Header-Name: header value",
		headersExample:
			"e.g.:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		templateDescription:
			"URL templates use Mustache template syntax. The current implementation uses URL encoding instead of HTML escaping.",
		variableSubstitution:
			"Variable substitution: {{variable}} - Automatically URL encoded (using encodeURIComponent)",
		rawContent:
			"Raw content: {{{variable}}} - No encoding, outputs raw value",
		functionCall:
			"Function call: {{#function}}content{{/function}} - Calls custom function to process content",
		comment: "Comment: {{! comment }} - Not displayed in output",
		viewDocumentation: "View complete Mustache syntax documentation",
		encodingDescription: "Encoding Instructions",
		doubleBrace:
			"Double braces {{variable}} are automatically URL encoded (encodeURIComponent)",
		tripleBrace:
			"Triple braces {{{variable}}} preserve raw content without any encoding",
		availableVariables: "Available Variables",
		rawURL: "{{rawURL}} - Original URL used in the note",
		urlObject: "{{url}} - Parsed JavaScript URL object",
		cid: "{{cid}} - IPFS root content ID, multiformats CID object, can also be formatted directly as a string",
		pathname: "{{url.pathname}} - IPFS optional subpath",
		search: "{{url.search}} - URL parameter part",
		filename: "{{filename}} - File name (obtained from URL parameters)",
		format: "{{format}} - File format (obtained from URL parameters)",
		casPath: "{{casPath}} - Local storage relative path",
		encodeFunction:
			"{{#encodeURI}}content{{/encodeURI}} - URI encoding helper function to avoid path separator escaping (default will be escaped)",
		localGatewayExample: "Local Gateway Example",
		githubExample: "GitHub Raw Example",
	},
	zh: {
		localStorage: "本地存储",
		localStorageDesc: "用于存储内容寻址附件的本地目录路径",
		externalStorage: "外部存储",
		externalStorageDesc:
			"用于获取本地缺少的文件，使用 Mustache 模板语法定义 URL 格式",
		addExternalStorage: "添加外部存储",
		templateSyntaxHelp: "模板语法说明",
		editHeaders: "编辑请求头",
		delete: "删除",
		newExternalStorage: "新外部存储",
		configurationName: "配置名称",
		urlTemplate: "URL模板（Mustache语法）",
		close: "关闭",
		save: "保存",
		cancel: "取消",
		examplePlaceholder: "例如: .attachments/cas",
		headersDescription: "每行一个请求头，格式为: Header-Name: header value",
		headersExample:
			"例如:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		templateDescription:
			"URL 模板使用 Mustache 模板语法，当前实现使用 URL 编码而非 HTML 转义。",
		variableSubstitution:
			"变量替换: {{variable}} - 自动进行 URL 编码（使用 encodeURIComponent）",
		rawContent: "原始内容: {{{variable}}} - 不进行编码，直接输出原始值",
		functionCall:
			"函数调用: {{#function}}content{{/function}} - 调用自定义函数处理内容",
		comment: "注释: {{! comment }} - 不会在输出中显示",
		viewDocumentation: "查看完整的 Mustache 语法文档",
		encodingDescription: "编码说明",
		doubleBrace:
			"双花括号 {{variable}} 会自动进行 URL 编码（encodeURIComponent）",
		tripleBrace: "三花括号 {{{variable}}} 会保持原始内容，不进行任何编码",
		availableVariables: "可用变量",
		rawURL: "{{rawURL}} - 笔记中使用的原始URL",
		urlObject: "{{url}} - 解析后的 JavaScript URL 对象",
		cid: "{{cid}} - IPFS 根内容 ID, multiformats CID对象，也能直接格式化为字符串",
		pathname: "{{url.pathname}} - IPFS 可选子路径",
		search: "{{url.search}} - URL参数部分",
		filename: "{{filename}} - 文件名（从URL参数获取）",
		format: "{{format}} - 文件格式（从URL参数获取）",
		casPath: "{{casPath}} - 本地存储相对路径",
		encodeFunction:
			"{{#encodeURI}}内容{{/encodeURI}} - URI编码辅助函数，用于避免路径分隔符被转义（默认会被转义）",
		localGatewayExample: "本地网关示例",
		githubExample: "GitHub Raw 示例",
	},
});
//#endregion

export default class MainPluginSettingTab extends PluginSettingTab {
	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
				.addText((text) =>
					text
						.setPlaceholder(t("configurationName"))
						.setValue(config.name)
						.onChange(async (value) => {
							config.name = value;
							await this.plugin.saveSettings();
						}),
				)
				.addText((text) => {
					const input = text
						.setPlaceholder(t("urlTemplate"))
						.setValue(config.urlTemplate)
						.onChange(async (value) => {
							config.urlTemplate = value;
							await this.plugin.saveSettings();
						});

					input.inputEl.setCssStyles({
						minWidth: "300px",
						flexGrow: "1",
					});
					return input;
				})
				.addExtraButton((button) =>
					button
						.setIcon("settings")
						.setTooltip(t("editHeaders"))
						.onClick(() => {
							new HeadersEditModal(
								this.app,
								config,
								(newHeaders) => {
									config.headers = newHeaders;
									this.plugin
										.saveSettings()
										.catch(console.error);
								},
							).open();
						}),
				)
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
			const info = setting.settingEl.querySelector(".setting-item-info");
			if (info instanceof HTMLElement) {
				info.setCssStyles({ display: "none" });
			}
		});

		//#region 模板语法说明
		const mustacheHelp = containerEl.createEl("details");
		mustacheHelp.createEl("summary", {
			text: t("templateSyntaxHelp"),
		});
		const mustacheContent = mustacheHelp.createEl("div");

		mustacheContent.createEl("p", {
			text: t("templateDescription"),
		});

		const mustacheList = mustacheContent.createEl("ul");

		mustacheList.createEl("li", {
			text: t("variableSubstitution"),
		});

		mustacheList.createEl("li", {
			text: t("rawContent"),
		});

		mustacheList.createEl("li", {
			text: t("functionCall"),
		});

		mustacheList.createEl("li", {
			text: t("comment"),
		});

		mustacheContent.createEl("p").createEl("a", {
			text: t("viewDocumentation"),
			href: "https://mustache.github.io/mustache.5.html",
			attr: { target: "_blank" },
		});

		// 转义规则说明
		const escapeHelp = mustacheContent.createEl("details");
		escapeHelp.createEl("summary", { text: t("encodingDescription") });
		const escapeList = escapeHelp.createEl("ul");

		escapeList.createEl("li", {
			text: t("doubleBrace"),
		});

		escapeList.createEl("li", {
			text: t("tripleBrace"),
		});

		// 占位符说明
		const placeholderHelp = containerEl.createEl("details");
		placeholderHelp.createEl("summary", { text: t("availableVariables") });
		const helpList = placeholderHelp.createEl("ul");

		helpList.createEl("li", {
			text: t("rawURL"),
		});

		helpList.createEl("li", {
			text: t("urlObject"),
		});

		helpList.createEl("li", {
			text: t("cid"),
		});

		helpList.createEl("li", {
			text: t("pathname"),
		});

		helpList.createEl("li", {
			text: t("search"),
		});

		helpList.createEl("li", {
			text: t("filename"),
		});

		helpList.createEl("li", {
			text: t("format"),
		});

		helpList.createEl("li", {
			text: t("casPath"),
		});

		helpList.createEl("li", {
			text: t("encodeFunction"),
		});

		// #endregion;
	}
}

// 请求头编辑模态框
class HeadersEditModal extends Modal {
	constructor(
		app: App,
		private config: GatewayURLConfig,
		private onSave: (headers: [key: string, value: string][]) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: t("editHeaders") });

		// 说明文本
		contentEl.createEl("p", {
			text: t("headersDescription"),
		});

		// 文本区域
		const textArea = new TextAreaComponent(contentEl)
			.setPlaceholder(t("headersExample"))
			.setValue(this.headersToString(this.config.headers))
			.then((component) => {
				component.inputEl.setCssStyles({
					width: "100%",
					height: "200px",
					fontFamily: "monospace",
				});
			});

		// 按钮容器
		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		// 保存按钮
		const saveButton = buttonContainer.createEl("button", {
			text: t("save"),
			cls: "mod-cta",
		});

		saveButton.addEventListener("click", () => {
			const headersText = textArea.getValue();
			const headers = this.stringToHeaders(headersText);
			this.onSave(headers);
			this.close();
		});

		// 取消按钮
		const cancelButton = buttonContainer.createEl("button", {
			text: t("cancel"),
		});

		cancelButton.addEventListener("click", () => {
			this.close();
		});
	}

	// 将headers数组转换为字符串
	private headersToString(headers: [key: string, value: string][]): string {
		return headers.map(([key, value]) => `${key}: ${value}`).join("\n");
	}

	// 将字符串解析为headers数组
	private stringToHeaders(text: string): [key: string, value: string][] {
		const headers: [key: string, value: string][] = [];
		const lines = text.split("\n");

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine) continue;

			const colonIndex = trimmedLine.indexOf(":");
			if (colonIndex === -1) {
				// 如果没有冒号，跳过这一行
				continue;
			}

			const key = trimmedLine.substring(0, colonIndex).trim();
			const value = trimmedLine.substring(colonIndex + 1).trim();

			if (key) {
				headers.push([key, value]);
			}
		}

		return headers;
	}
}

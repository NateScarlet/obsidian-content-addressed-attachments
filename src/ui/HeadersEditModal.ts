import { Modal, TextAreaComponent, type App } from "obsidian";
import defineLocales from "../utils/defineLocales";
import type { GatewayURLConfig } from "src/URLResolver";

export default class HeadersEditModal extends Modal {
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

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		editHeaders: "Edit Headers",
		headersDescription:
			"One header per line, format: Header-Name: header value",
		headersExample:
			"e.g.:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		save: "Save",
		cancel: "Cancel",
	},
	zh: {
		editHeaders: "编辑请求头",
		headersDescription: "每行一个请求头，格式为: Header-Name: header value",
		headersExample:
			"例如:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		save: "保存",
		cancel: "取消",
	},
});
//#endregion

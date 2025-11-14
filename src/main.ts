// main.ts
import {
	FileSystemAdapter,
	MarkdownView,
	Notice,
	Plugin,
	requestUrl,
} from "obsidian";
import isAbortError from "./utils/isAbortError";
import { LocalCAS } from "./LocalCAS";
import mustache from "mustache";
import { CID } from "multiformats/cid";
import { dirname, join } from "path-browserify";
import MainPluginSettingTab from "./MainPluginSettingTab";
import openExternalURL from "./utils/openExternalLink";
import { MigrationProgressModal } from "./MigrationProgressModal";
import { MigrationManager } from "./MigrationManager";
import defineLocales from "./utils/defineLocales";

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		insertAttachment: "Insert attachment",
		migrateComplete: (migrated: number) =>
			`Migration complete: successfully migrated ${migrated} files`,
		noMigrationNeeded: "No files need to be migrated",
		migrationWithErrors: (errors: number) =>
			`Migration completed with ${errors} errors`,
		migrateFailed: "Migration failed",
		migrateCurrentNote: "Migrate files in current note",
		migrateAllNotes: "Migrate files in all notes",
		noActiveNote: "No active note",
		localGatewayExample: "Local Gateway Example",
		githubExample: "Github Repository Example",
	},
	zh: {
		insertAttachment: "插入附件",
		migrateComplete: (migrated: number) =>
			`迁移完成: 成功迁移 ${migrated} 个文件`,
		noMigrationNeeded: "没有发现需要迁移的文件",
		migrationWithErrors: (errors: number) =>
			`迁移完成，但有 ${errors} 个错误`,
		migrateFailed: "迁移失败",
		migrateCurrentNote: "迁移当前笔记中的文件",
		migrateAllNotes: "迁移所有笔记中的文件",
		noActiveNote: "没有活动的笔记",
		localGatewayExample: "本地网关示例",
		githubExample: "Github 仓库示例",
	},
});
//#endregion

// 默认设置（国际化）
function getDefaultSettings() {
	return {
		casDir: ".attachments/cas",
		gatewayURLs: [
			{
				name: "IPFS.io",
				urlTemplate:
					"https://ipfs.io/ipfs/{{cid}}{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: true,
			},
			{
				name: "dweb.link",
				urlTemplate:
					"https://{{cid}}.ipfs.dweb.link{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: true,
			},
			{
				name: "4EVERLAND",
				urlTemplate:
					"https://{{cid}}.ipfs.4everland.io{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: false,
			},
			{
				name: t("localGatewayExample"),
				urlTemplate:
					"http://127.0.0.1:8080/ipfs/{{cid}}{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: false,
			},
			{
				name: t("githubExample"),
				urlTemplate:
					"https://raw.githubusercontent.com/OWNER/REPO/main/{{{#encodeURI}}}{{{casPath}}}{{{/encodeURI}}}",
				headers: [
					["Authorization", "Token YOUR_PERSONAL_ACCESS_TOKEN"],
				],
				enabled: false,
			},
		],
	};
}

// 模板数据类型接口
type TemplateLambda = () => (
	text: string,
	render: (text: string) => string,
) => string;

interface TemplateData {
	rawURL: string;
	url: URL;
	cid: CID;

	// 计算函数
	filename: () => string;
	format: () => string;
	casPath: () => string;

	// 辅助函数
	encodeURI: TemplateLambda;
}

// 插件设置接口
export interface Settings {
	casDir: string;
	gatewayURLs: GatewayURLConfig[];
}

export interface GatewayURLConfig {
	urlTemplate: string;
	name: string;
	headers: [key: string, value: string][];
	enabled: boolean;
}

export interface CAS {
	pathFromCID(cid: CID): string;
	save(file: File): Promise<{ cid: CID; didCreate: boolean }>;
}

export default class ContentAddressedAttachmentPlugin extends Plugin {
	settings: Settings;
	public cas: CAS;
	private inProgressElements = new WeakSet<HTMLElement>();
	private stack = new DisposableStack();

	async onload() {
		await this.loadSettings();

		this.cas = new LocalCAS(this.app, () => this.settings.casDir);

		// 初始化 MutationObserver 来监控所有模式下的 DOM 变化
		this.setupMutationObserver();

		// 添加设置选项卡
		this.addSettingTab(new MainPluginSettingTab(this));

		this.registerEvent(
			this.app.workspace.on("editor-paste", async (e, editor) => {
				const files = e.clipboardData?.files;
				if (e.defaultPrevented || !files?.length) {
					return;
				}
				for (let i = 0; i < files.length; i++) {
					const file = files.item(i);
					e.preventDefault();
					if (file) {
						const text = await this.generateMarkdownLink(file);
						editor.replaceRange(
							text,
							editor.getCursor("from"),
							editor.getCursor("to"),
						);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", async (e, editor) => {
				const files = e.dataTransfer?.files;
				if (e.defaultPrevented || !files?.length) {
					return;
				}
				for (let i = 0; i < files.length; i++) {
					const file = files.item(i);
					e.preventDefault();
					if (file) {
						const text = await this.generateMarkdownLink(file);
						editor.replaceRange(
							text,
							editor.getCursor("from"),
							editor.getCursor("to"),
						);
					}
				}
			}),
		);

		this.registerDomEvent(
			document,
			"click",
			async (e) => {
				if (e.defaultPrevented) {
					return;
				}
				const el = e.target;
				if (el instanceof HTMLElement) {
					const url = el.textContent;
					if (url.startsWith("ipfs://")) {
						e.preventDefault();
						e.stopPropagation();

						const resolved = await this.resolveURL(url);
						if (
							resolved?.path &&
							this.app.vault.adapter instanceof FileSystemAdapter
						) {
							openExternalURL(
								this.app.vault.adapter.getFilePath(
									dirname(resolved.path),
								),
							);
						} else {
							openExternalURL(resolved?.href || url);
						}
					}
				}
			},
			{ capture: true },
		);

		this.addCommand({
			id: "insert-attachment",
			name: t("insertAttachment"),
			callback: () => {
				window
					.showOpenFilePicker({
						id: "insert-attachment-ee03d94fe3c6",
						multiple: true,
					})
					.then(async (handles) => {
						const files = await Promise.all(
							handles.map((h) => h.getFile()),
						);
						const view =
							this.app.workspace.getActiveViewOfType(
								MarkdownView,
							);
						if (!view) {
							return;
						}
						const editor = view.editor;
						for (const file of files) {
							const text = await this.generateMarkdownLink(file);
							editor.replaceRange(
								text,
								editor.getCursor("from"),
								editor.getCursor("to"),
							);
						}
					})
					.catch((err) => {
						new Notice(String(err));
					});
			},
		});

		this.addCommand({
			id: "migrate-current-note",
			name: t("migrateCurrentNote"),
			callback: () => this.executeMigration("current"),
		});

		this.addCommand({
			id: "migrate-all-notes",
			name: t("migrateAllNotes"),
			callback: () => this.executeMigration("all"),
		});

		// 初始处理
		this.process().catch(console.error);
	}

	private async executeMigration(scope: "current" | "all") {
		const progressModal = new MigrationProgressModal(this.app, (result) => {
			// 迁移完成后的处理
			if (result.migrated > 0) {
				new Notice(t("migrateComplete")(result.migrated));
			} else if (result.skipped > 0) {
				new Notice(t("noMigrationNeeded"));
			}

			if (result.errors > 0) {
				new Notice(t("migrationWithErrors")(result.errors));
			}
		});

		progressModal.open();
		const manager = new MigrationManager(this);

		try {
			let result;
			if (scope === "current") {
				result = await manager.migrateCurrentNote();
			} else {
				result = await manager.migrateAllNotes();
			}
			progressModal.updateProgress(result);
		} catch (error) {
			progressModal.showError(String(error));
			console.error("迁移失败:", error);
		}
	}

	private async generateMarkdownLink(file: File): Promise<string> {
		const { cid } = await this.cas.save(file);
		const url = new URL(`ipfs://${cid.toString()}`);
		if (file.name) {
			url.searchParams.set("filename", file.name);
		}
		if (file.type) {
			url.searchParams.set("format", file.type);
		}
		if (file.type.startsWith("image/")) {
			return `![${file.name || "image"}](${url})`;
		} else {
			return `[${file.name ?? "attachment"}](${url})`;
		}
	}

	private setupMutationObserver() {
		const observer = this.stack.adopt(
			new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					if (mutation.target instanceof HTMLElement) {
						this.process(mutation.target).catch(console.error);
					}
					mutation.addedNodes.forEach((node) => {
						if (node instanceof HTMLElement) {
							this.process(node).catch(console.error);
						}
					});
				});
			}),
			(i) => i.disconnect(),
		);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
	}

	private async processElementURL(el: HTMLElement) {
		if (this.inProgressElements.has(el)) {
			return;
		}
		using stack = new DisposableStack();
		this.inProgressElements.add(el);
		stack.defer(() => this.inProgressElements.delete(el));

		for (const attr of ["src", "href"]) {
			const value = el.getAttribute(attr);
			if (value?.startsWith("ipfs://")) {
				el.setAttr(attr, ""); // 避免发起请求
				console.debug("🖼️ 处理 URL:", value);
				const resolvedURL = await this.resolveURL(value);
				if (resolvedURL) {
					console.debug("使用源:", resolvedURL);
					el.setAttr(`data-original-${attr}`, value);
					el.setAttr(attr, resolvedURL.href);
				} else {
					el.setAttr(attr, value);
					console.warn("无可用源:", value);
				}
			}
		}
	}

	private async resolveURL(
		rawURL: string,
	): Promise<{ path?: string; href: string } | undefined> {
		using stack = new DisposableStack();
		const ctr = stack.adopt(new AbortController(), (i) => i.abort());
		const data = this.prepareTemplateData(rawURL);

		const localPath = join(this.settings.casDir, data.casPath());
		console.debug("matching local path", localPath);
		if (await this.app.vault.adapter.exists(localPath)) {
			return {
				path: localPath,
				href: this.app.vault.adapter.getResourcePath(localPath),
			};
		}
		let remaining = this.settings.gatewayURLs.length;
		try {
			return await Promise.race(
				this.settings.gatewayURLs.map((config) => {
					return new Promise<
						Awaited<ReturnType<typeof this.resolveURL>>
					>((resolve) => {
						(async () => {
							stack.defer(() => resolve(undefined)); // 确保退出后所有Promise一定处于完成状态
							try {
								if (!config.enabled) {
									return;
								}
								const url = this.renderGatewayURL(
									rawURL,
									config,
								);
								if (!url) {
									return;
								}
								const headers = new Headers(config.headers);
								if (!headers.has("Accept")) {
									headers.set(
										"Accept",
										data.format() || "*/*",
									);
								}
								const headersRecord: Record<string, string> =
									{};
								headers.forEach((v, k) => {
									headersRecord[k] = v;
								});

								// XXX: requestUrl 接口不支持 signal，没法中途取消，只能先用 HEAD 来预检
								const resp = await requestUrl({
									url,
									method: "HEAD",
									headers: headersRecord,
								});
								if (resp.status == 200) {
									console.debug("GET", url);

									const resp = await requestUrl({
										url,
										headers: headersRecord,
										throw: false,
									});
									if (resp.status === 200) {
										console.debug("GOT", resp.headers);
										resolve({
											href: this.stack.adopt(
												URL.createObjectURL(
													new Blob(
														[resp.arrayBuffer],
														{
															type:
																data.format() ||
																resp.headers[
																	"content-type"
																] ||
																undefined,
														},
													),
												),
												(i) => URL.revokeObjectURL(i),
											),
										});
									}
									return;
								}
							} finally {
								remaining -= 1;
								if (remaining === 0) {
									resolve(undefined);
								}
							}
						})().catch((err) => {
							console.error("Failed to fetch", config, rawURL);
						});
					});
				}),
			);
		} catch (err) {
			if (!isAbortError(err)) {
				console.error("解析 IPFS 网址失败", rawURL, err);
			}
		}
	}

	// 处理所有已存在的链接
	private async process(parent: ParentNode = document): Promise<void> {
		const match = parent.querySelectorAll<HTMLElement>(
			'[src^="ipfs://"], [href^="ipfs://"]',
		);

		const jobs: Promise<void>[] = [];
		match.forEach((element) => {
			jobs.push(this.processElementURL(element));
		});
		await Promise.all(jobs);
	}

	// 生成模板数据
	private prepareTemplateData(rawURL: string): TemplateData {
		const url = new URL(rawURL);
		if (!url || url.protocol != "ipfs:") {
			throw new Error(`invalid url: '${url}'`);
		}
		const cid = CID.parse(url.host);
		if (!cid) {
			throw new Error(`invalid cid in url: '${url}'`);
		}
		const casPath = this.cas.pathFromCID(cid);

		return {
			rawURL,
			url,
			cid,
			filename: () => url.searchParams.get("filename") || "",
			format: () => url.searchParams.get("format") || "",
			casPath: () => casPath,
			encodeURI: () => (text, render) => encodeURIComponent(render(text)),
		};
	}

	private renderGatewayURL(rawURL: string, config: GatewayURLConfig): string {
		if (!rawURL || !config.urlTemplate) return "";
		const templateData = this.prepareTemplateData(rawURL);
		return mustache.render(config.urlTemplate, templateData, undefined, {
			escape: encodeURIComponent,
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			getDefaultSettings(),
			(await this.loadData()) as Settings,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		this.stack.dispose();
	}
}

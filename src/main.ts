//main.ts
import { MarkdownView, Notice, Plugin } from "obsidian";
import { LocalCAS } from "./LocalCAS";
import { CID } from "multiformats/cid";
import MainPluginSettingTab from "./ui/MainPluginSettingTab";
import { MigrationManager } from "./MigrationManager";
import defineLocales from "./utils/defineLocales";
import IPFSLinkClickExtension from "./IPFSLinkClickExtension";
import { URLResolver } from "./URLResolver";

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
	formatRelPath(cid: CID): string;
	trash(cid: CID, invalid?: boolean): Promise<void>;
	load(
		cid: CID,
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined>;
	save(file: File): Promise<{ cid: CID; didCreate: boolean }>;
}

export default class ContentAddressedAttachmentPlugin extends Plugin {
	public settings: Settings;
	public cas: CAS;
	public urlResolver: URLResolver;

	private inProgressElements = new WeakSet<HTMLElement>();
	private stack = new DisposableStack();
	private migrationManager: MigrationManager;

	async onload() {
		await this.loadSettings();

		this.cas = new LocalCAS(this.app, () => this.settings.casDir);
		this.urlResolver = new URLResolver(
			this.app,
			this.cas,
			() => this.settings,
		);
		this.migrationManager = this.stack.use(new MigrationManager(this));

		this.setupMutationObserver();

		this.registerEditorExtension(
			new IPFSLinkClickExtension(this).createExtension(),
		);

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
			callback: () => this.migrationManager.execute("current"),
		});

		this.addCommand({
			id: "migrate-all-notes",
			name: t("migrateAllNotes"),
			callback: () => this.migrationManager.execute("all"),
		});

		this.process().catch(console.error);
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
				console.debug("🖼️ 处理 URL:", value);
				const resolvedURL = await this.urlResolver.resolveURL(value);
				if (resolvedURL) {
					console.debug("使用源:", resolvedURL);
					el.setAttr(`data-original-${attr}`, value);
					el.setAttr(attr, resolvedURL.url);
				} else {
					el.setAttr(attr, value);
					console.warn("无可用源:", value);
				}
			}
		}
	}

	private async process(parent: ParentNode = document): Promise<void> {
		const match = parent.querySelectorAll<HTMLElement>(
			'[src^="ipfs://"], [href^="ipfs://"]',
		);

		const jobs: Promise<void>[] = [];
		match.forEach((element) => {
			jobs.push(this.processElementURL(element));
		});
		await Promise.allSettled(jobs);
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

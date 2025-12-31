import { Plugin, TFile } from "obsidian";
import MainPluginSettingTab from "./ui/MainPluginSettingTab";
import { MigrationManager } from "./MigrationManager";
import defineLocales from "./utils/defineLocales";
import { URLResolver } from "./URLResolver";
import {
	getDefaultSettings,
	settingsFromInput,
	type Settings,
	type SettingsInput,
} from "./settings";
import createImagePlaceholderSVG from "./utils/createImagePlaceholderSVG";
import {
	CASFileExplorerView,
	CAS_FILE_EXPLORER_VIEW_TYPE,
} from "./ui/CASFileExplorerView";
import type { CASMetadata } from "./types/CASMetadata";
import { CASMetadataImpl } from "./infrastructure/indexed-db/CASMetadataImpl";
import { CASImpl } from "./infrastructure/local/CASImpl";
import type { CAS } from "./types/CAS";
import ReferenceManager from "./ReferenceManager";
import CASMetadataObjectFilterBuilder from "./CASMetadataObjectFilterBuilder";
import showError from "./utils/showError";
import { markdownChange } from "./events";
import createIPFSLinkClickExtension from "./createIPFSLinkClickExtension";
import insertAttachment from "./commands/insertAttachment";
import insertFileAtCursor from "./commands/insertFileAtCursor";
import { uniq } from "es-toolkit";
import { LockManager } from "./LockManager";

export default class ContentAddressedAttachmentPlugin extends Plugin {
	public settings: Settings;
	public cas: CAS;
	public casMetadata: CASMetadata;
	public urlResolver: URLResolver;
	public referenceManger = new ReferenceManager(this);

	private inProgressElements = new WeakSet<HTMLElement>();
	private stack = new DisposableStack();
	private migrationManager: MigrationManager;
	private lockManager: LockManager;

	private placeholderImageURL: string;
	private notFoundImageURL: string;

	async onload() {
		await this.loadSettings();
		this.placeholderImageURL = this.stack.adopt(
			URL.createObjectURL(
				new Blob([createImagePlaceholderSVG(t("loading"), "loading")], {
					type: "image/svg+xml",
				}),
			),
			(i) => URL.revokeObjectURL(i),
		);
		this.notFoundImageURL = this.stack.adopt(
			URL.createObjectURL(
				new Blob(
					[createImagePlaceholderSVG(t("fileNotFound"), "error")],
					{
						type: "image/svg+xml",
					},
				),
			),
			(i) => URL.revokeObjectURL(i),
		);

		this.casMetadata = new CASMetadataImpl(
			new CASMetadataObjectFilterBuilder(this.referenceManger),
		);
		this.cas = new CASImpl(this.app, this.casMetadata, () => {
			return uniq([
				this.settings.primaryDir,
				this.settings.downloadDir,
				...this.settings.gateways
					.map((i) => i.downloadDir ?? "")
					.filter((i) => !!i),
			]);
		});
		this.urlResolver = new URLResolver(
			this.app,
			this.cas,
			() => this.settings,
		);
		this.migrationManager = this.stack.use(new MigrationManager(this));
		this.lockManager = this.stack.use(new LockManager(this));

		this.setupMutationObserver();

		this.registerEditorExtension(
			createIPFSLinkClickExtension(this.urlResolver),
		);

		this.addSettingTab(new MainPluginSettingTab(this));

		//#region 事件注册
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
						const { cid } = await this.cas.save(
							this.settings.primaryDir,
							file,
						);
						insertFileAtCursor(file, cid, editor);
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
						const { cid } = await this.cas.save(
							this.settings.primaryDir,
							file,
						);
						insertFileAtCursor(file, cid, editor);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					markdownChange.dispatch(file);
					void this.referenceManger.loadFile(file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (view.file && view.file.extension === "md") {
					markdownChange.dispatch(view.file);
					void this.referenceManger.loadFileContent(
						view.file.path,
						editor.getValue(),
					);
				}
			}),
		);
		//#endregion

		this.addCommand({
			id: "insert-attachment",
			name: t("insertAttachment"),
			callback: () => {
				insertAttachment(
					this.app,
					this.cas,
					this.settings.primaryDir,
				).catch(showError);
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

		this.addCommand({
			id: "migrate-current-note",
			name: t("lockCurrentNote"),
			callback: () => this.migrationManager.execute("current"),
		});

		this.addCommand({
			id: "migrate-all-notes",
			name: t("lockAllNotes"),
			callback: () => this.migrationManager.execute("all"),
		});

		this.addCommand({
			id: "migrate-current-note",
			name: t("lockCurrentNote"),
			callback: () => this.lockManager.execute("current"),
		});

		this.addCommand({
			id: "migrate-all-notes",
			name: t("lockAllNotes"),
			callback: () => this.lockManager.execute("all"),
		});

		// 注册文件管理器视图
		this.registerView(
			CAS_FILE_EXPLORER_VIEW_TYPE,
			(leaf) => new CASFileExplorerView(leaf, this),
		);

		// 添加打开文件管理器的命令
		this.addCommand({
			id: "open-cas-explorer",
			name: t("openCASExplorer"),
			callback: () => {
				this.revealFileExplorer().catch(showError);
			},
		});
		this.addRibbonIcon("hard-drive", t("openCASExplorer"), () => {
			this.revealFileExplorer().catch(showError);
		});

		this.process().catch(showError);
	}

	private async revealFileExplorer(): Promise<void> {
		const { workspace } = this.app;
		const leaf =
			workspace.getLeavesOfType(CAS_FILE_EXPLORER_VIEW_TYPE)[0] ??
			workspace.getLeftLeaf(false);

		await leaf.setViewState({
			type: CAS_FILE_EXPLORER_VIEW_TYPE,
			active: true,
		});
		await workspace.revealLeaf(leaf);
	}

	private setupMutationObserver() {
		const observer = this.stack.adopt(
			new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					if (mutation.target instanceof HTMLElement) {
						this.process(mutation.target).catch(showError);
					}
					mutation.addedNodes.forEach((node) => {
						if (node instanceof HTMLElement) {
							this.process(node).catch(showError);
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
			if (
				value?.startsWith("ipfs://") ||
				value?.startsWith("internal.ipfs-locked:")
			) {
				console.debug("🖼️ 处理 URL:", value);
				if (el instanceof HTMLImageElement && attr === "src") {
					el.src = this.placeholderImageURL;
				}
				const resolvedURL = await this.urlResolver.resolveURL(value);
				if (resolvedURL) {
					console.debug("使用源:", resolvedURL);
					el.setAttr(`data-original-${attr}`, value);
					el.setAttr(attr, resolvedURL.url);
				} else {
					if (el instanceof HTMLImageElement && attr === "src") {
						el.src = this.notFoundImageURL;
					} else {
						el.setAttr(attr, value);
					}
					console.warn("无可用源:", value);
				}
			}
		}
	}

	private async process(parent: ParentNode = document): Promise<void> {
		const match = parent.querySelectorAll<HTMLElement>(
			'[src^="ipfs://"], [href^="ipfs://"], [src^="internal.ipfs-locked:"], [href^="internal.ipfs-locked:"]',
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
			settingsFromInput((await this.loadData()) as SettingsInput),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		this.stack.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		insertAttachment: "Insert attachment",
		migrateCurrentNote: "Migrate local files (current note)",
		migrateAllNotes: "Migrate local files (all notes)",
		lockCurrentNote:
			"Add checksum and auto-cache for web files (current note)",
		lockAllNotes: "Add checksum and auto-cache for web files (all notes)",
		loading: "Loading",
		fileNotFound: "File not found",
		openCASExplorer: "Open CAS File Explorer",
	},
	zh: {
		insertAttachment: "插入附件",
		migrateCurrentNote: "迁移本地文件（当前笔记）",
		migrateAllNotes: "迁移本地文件 （所有笔记）",
		lockCurrentNote: "为网络文件添加校验和自动缓存（当前笔记）",
		lockAllNotes: "为网络文件添加校验和自动缓存（所有笔记）",
		loading: "正在加载",
		fileNotFound: "未找到文件",
		openCASExplorer: "打开 CAS 文件管理器",
	},
});
//#endregion

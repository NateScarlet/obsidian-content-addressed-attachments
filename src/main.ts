import { Notice, Plugin, TFile, MarkdownView } from "obsidian";
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
import insertAttachment, {
	processFileAndInsertLink,
} from "./commands/insertAttachment";
import {
	encryptLink,
	decryptLink,
	isEncryptedLink,
	findLinkAtPos,
	type EncryptContext,
} from "./commands/convertAttachment";
import { uniq } from "es-toolkit";
import { LockManager } from "./LockManager";
import restoreReferencedFiles from "./commands/restoreReferencedFiles";
import {
	createReprocessContext,
	reprocessCurrentNote,
	reprocessSharedMessages,
	reprocessSingleLinkCommand,
	reprocessWholeVault,
} from "./commands/reprocessAttachments";
import IPFSLink from "./utils/IPFSLink";
import findIPFSLinks from "./utils/findIPFSLinks";
import patchElementURL, {
	patchElementBackgroundImage,
} from "./utils/patchElementURLs";
import KeyManager from "./lib/encryption/KeyManager";
import EncryptionService from "./lib/encryption/EncryptionService";
import EncryptPathPolicy from "./lib/encryption/EncryptPathPolicy";
import type { KeyStorage } from "./lib/encryption/types";
import TransformPipeline from "./preprocess/TransformPipeline";
import DefaultScriptLoader from "./preprocess/ScriptLoader";
import type { ScriptLoader } from "./preprocess/types";
import createScriptLoaderOptions from "./preprocess/createScriptLoaderOptions";

export default class ContentAddressedAttachmentPlugin extends Plugin {
	declare public settings: Settings;
	public cas!: CAS;
	public casMetadata!: CASMetadata;
	public urlResolver!: URLResolver;
	public referenceManager = new ReferenceManager(this);
	public keyManager!: KeyManager;
	public encryptionService!: EncryptionService;
	public encryptPathPolicy!: EncryptPathPolicy;

	public get hasSecretStorage(): boolean {
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		return !!this.app.secretStorage;
	}

	private inProgressElements = new WeakSet<HTMLElement>();
	private stack = new DisposableStack();
	public migrationManager!: MigrationManager;
	public lockManager!: LockManager;
	public pipeline!: TransformPipeline;
	public scriptLoader!: ScriptLoader;

	private placeholderImageURL!: string;
	private notFoundImageURL!: string;

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
			new CASMetadataObjectFilterBuilder(this.referenceManager),
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
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		const secretStorage = this.app.secretStorage;
		const storage: KeyStorage = secretStorage ?? {
			getSecret() {
				return Promise.resolve(undefined);
			},
			setSecret() {
				throw new Error(
					"Secret storage is not available in this Obsidian version",
				);
			},
			listSecrets() {
				return Promise.resolve([]);
			},
		};
		this.keyManager = new KeyManager(
			storage,
			() => this.settings,
			() => this.saveSettings(),
		);
		this.encryptionService = new EncryptionService(this.keyManager);
		this.encryptPathPolicy = new EncryptPathPolicy(
			this.keyManager,
			this.encryptionService,
			() => this.settings.encryptPathRules,
		);
		this.urlResolver = this.stack.use(
			new URLResolver(
				this.app,
				this.cas,
				() => this.settings,
				this.encryptionService,
			),
		);
		this.migrationManager = this.stack.use(new MigrationManager(this));
		this.lockManager = this.stack.use(new LockManager(this));

		// 初始化预处理管线
		this.scriptLoader = new DefaultScriptLoader(
			createScriptLoaderOptions({
				app: this.app,
				urlResolver: this.urlResolver,
				onScriptURLResolved: (_originalURL, lockedURL) => {
					this.settings.preProcess.scriptURL = lockedURL;
					this.saveData(this.settings).catch(showError);
					new Notice(t("httpsScriptLocked")(lockedURL));
				},
			}),
		);
		this.pipeline = new TransformPipeline(
			this.scriptLoader,
			() => this.settings.preProcess.scriptURL,
		);

		this.setupMutationObserver();

		this.registerEditorExtension(
			createIPFSLinkClickExtension(this.urlResolver),
		);

		this.addSettingTab(new MainPluginSettingTab(this));

		//#region 事件注册
		this.registerEvent(
			this.app.workspace.on("editor-paste", async (e, editor, info) => {
				const files = e.clipboardData?.files;
				if (e.defaultPrevented || !files?.length) {
					return;
				}
				const notePath = info.file?.path ?? "";
				for (let i = 0; i < files.length; i++) {
					const file = files.item(i);
					e.preventDefault();
					if (file) {
						await processFileAndInsertLink(
							this.cas,
							this.settings.primaryDir,
							editor,
							file,
							notePath,
							this.encryptPathPolicy,
							this.pipeline,
							this.app.vault,
						);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", async (e, editor, info) => {
				const files = e.dataTransfer?.files;
				if (e.defaultPrevented || !files?.length) {
					return;
				}
				const notePath = info.file?.path ?? "";
				for (let i = 0; i < files.length; i++) {
					const file = files.item(i);
					e.preventDefault();
					if (file) {
						await processFileAndInsertLink(
							this.cas,
							this.settings.primaryDir,
							editor,
							file,
							notePath,
							this.encryptPathPolicy,
							this.pipeline,
							this.app.vault,
						);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					markdownChange.dispatch({ detail: file });
					void this.referenceManager.loadFile(file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (view.file && view.file.extension === "md") {
					markdownChange.dispatch({ detail: view.file });
					void this.referenceManager.loadFileContent(
						view.file.path,
						editor.getValue(),
					);
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (!view.file) return;
				const from = editor.getCursor("from");
				const to = editor.getCursor("to");
				const content = editor.getValue();
				const fromOffset = editor.posToOffset(from);
				const toOffset = editor.posToOffset(to);

				const ipfsLink =
					findLinkAtPos(content, fromOffset) ??
					findLinkAtPos(content, toOffset);

				if (ipfsLink) {
					const rawText =
						typeof ipfsLink.url.toURL === "function"
							? ipfsLink.url.toURL()
							: undefined;
					if (!rawText) return;
					const ctx: EncryptContext = {
						app: this.app,
						cas: this.cas,
						encryptionService: this.encryptionService,
						urlResolver: this.urlResolver,
						referenceManager: this.referenceManager,
						keyManager: this.keyManager,
						encryptPathPolicy: this.encryptPathPolicy,
					};
					const isEncrypted = isEncryptedLink(rawText);
					if (isEncrypted) {
						menu.addItem((item) => {
							item.setTitle(t("decryptLink"))
								.setIcon("lock-open")
								.onClick(() => {
									decryptLink(
										ctx,
										editor,
										ipfsLink,
										view.file?.path,
										this.settings.primaryDir,
									).catch(showError);
								});
						});
					} else {
						menu.addItem((item) => {
							item.setTitle(t("encryptLink"))
								.setIcon("lock")
								.onClick(() => {
									encryptLink(
										ctx,
										editor,
										ipfsLink,
										view.file?.path,
										this.settings.primaryDir,
									).catch(showError);
								});
						});
					}
					return;
				}

				const link =
					this.lockManager.findLinkAtOffset(content, fromOffset) ??
					this.lockManager.findLinkAtOffset(content, toOffset);

				if (link) {
					if (
						link.link.startsWith("http://") ||
						link.link.startsWith("https://")
					) {
						menu.addItem((item) => {
							item.setTitle(t("lockLink"))
								.setIcon("lock")
								.onClick(() => {
									this.lockManager
										.lockLink(view.file!, link)
										.catch(showError);
								});
						});
					} else if (link.link.startsWith("internal.ipfs-locked:")) {
						menu.addItem((item) => {
							item.setTitle(t("unlockLink"))
								.setIcon("lock-open")
								.onClick(() => {
									this.lockManager
										.unlockLink(view.file!, link)
										.catch(showError);
								});
						});
					}
				}

				// 重新处理单个链接（上下文菜单）
				const ipfsLinkForReprocess =
					findLinkAtPos(content, fromOffset) ??
					findLinkAtPos(content, toOffset);
				if (
					ipfsLinkForReprocess &&
					this.settings.preProcess.scriptURL
				) {
					menu.addItem((item) => {
						item.setTitle(t("reprocessLink"))
							.setIcon("refresh")
							.onClick(() => {
								reprocessSingleLinkCommand(
									reprocessCtx(),
									editor,
									ipfsLinkForReprocess,
									view.file?.path,
								).catch(showError);
							});
					});
				}
			}),
		);
		//#endregion

		// 解密缓存清理：当布局变化（笔记关闭/切换）时触发
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				const { app } = this;
				this.urlResolver.cleanupDecryptedCache(function* () {
					for (const leaf of app.workspace.getLeavesOfType(
						"markdown",
					)) {
						const view = leaf.view;
						if (!(view instanceof MarkdownView) || !view.file)
							continue;
						const content = view.editor.getValue();
						for (const match of findIPFSLinks(content)) {
							const parsed = IPFSLink.parse(match.url.toString());
							if (parsed) {
								yield parsed.cid.toString();
							}
						}
					}
				});
			}),
		);

		this.addCommand({
			id: "insert-attachment",
			name: t("insertAttachment"),
			callback: () => {
				insertAttachment(
					this.app,
					this.cas,
					this.settings.primaryDir,
					this.encryptPathPolicy,
					this.pipeline,
				).catch(showError);
			},
		});

		this.addCommand({
			id: "migrate-current-note",
			name: t("migrateCurrentNote"),
			callback: () => this.migrationManager.execute("current"),
		});

		this.addCommand({
			id: "lock-current-note",
			name: t("lockCurrentNote"),
			callback: () => this.lockManager.execute("current"),
		});

		this.addCommand({
			id: "restore-referenced-files",
			name: t("restoreReferencedFiles"),
			callback: () => {
				restoreReferencedFiles(this.cas, this.casMetadata)
					.then((count) => {
						if (count === 0) {
							new Notice(t("noReferencedFilesToRestore"));
						}
					})
					.catch(showError);
			},
		});

		// 重新处理附件命令：从插件实例组装共享上下文
		const reprocessCtx = () => createReprocessContext(this);

		this.addCommand({
			id: "reprocess-current-note",
			name: t("reprocessCurrentNote"),
			callback: () => {
				if (!this.settings.preProcess.scriptURL) {
					new Notice(t("noScriptConfigured"));
					return;
				}
				reprocessCurrentNote(reprocessCtx())
					.then((count) => {
						if (count > 0) {
							new Notice(t("reprocessComplete")(count));
						} else {
							new Notice(t("noAttachmentsFound"));
						}
					})
					.catch(showError);
			},
		});

		this.addCommand({
			id: "reprocess-whole-vault",
			name: t("reprocessWholeVault"),
			callback: () => {
				if (!this.settings.preProcess.scriptURL) {
					new Notice(t("noScriptConfigured"));
					return;
				}
				reprocessWholeVault(reprocessCtx()).catch(showError);
			},
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
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		await workspace.revealLeaf?.(leaf);
	}

	private setupMutationObserver() {
		const observer = this.stack.adopt(
			new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					if (mutation.target.instanceOf(HTMLElement)) {
						this.process(mutation.target).catch(showError);
					}
					mutation.addedNodes.forEach((node) => {
						if (node.instanceOf(HTMLElement)) {
							this.process(node).catch(showError);
						}
					});
				});
			}),
			(i) => i.disconnect(),
		);
		observer.observe(activeDocument.body, {
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

		const options = {
			placeholderImageURL: this.placeholderImageURL,
			notFoundImageURL: this.notFoundImageURL,
		};
		for (const attr of ["src", "href"]) {
			const value = el.getAttribute(attr);
			if (
				value?.startsWith("ipfs://") ||
				value?.startsWith("internal.ipfs-locked:")
			) {
				console.debug("🖼️ 处理 URL:", value);
				await patchElementURL(
					el,
					attr as "src" | "href",
					(rawURL) => this.urlResolver.resolveURL(rawURL),
					{
						imageFallback:
							el.instanceOf(HTMLImageElement) && attr === "src",
						...options,
					},
				);
			}
		}
	}

	/**
	 * 改写 Obsidian Base 卡片封面：Base 只接受 http(s) 封面值，因此 IPFS 链接
	 * 以 http:/// 前缀包装保留在 DOM 的 background-image 中，这里剥掉前缀走
	 * 统一解析后写回可访问的资源 URL（桌面与移动端同一套机制）。
	 * 异步解析返回后仅当背景图未被组件改掉时才写回，避免覆盖组件自己的修改。
	 */
	private async processElementBackgroundImage(el: HTMLElement) {
		if (this.inProgressElements.has(el)) {
			return;
		}
		using stack = new DisposableStack();
		this.inProgressElements.add(el);
		stack.defer(() => this.inProgressElements.delete(el));

		await patchElementBackgroundImage(el, (rawURL) =>
			this.urlResolver.resolveURL(rawURL),
		);
	}

	private async process(parent: ParentNode = activeDocument): Promise<void> {
		const match = parent.querySelectorAll<HTMLElement>(
			'[src^="ipfs://"], [href^="ipfs://"], [src^="internal.ipfs-locked:"], [href^="internal.ipfs-locked:"]',
		);
		// Base 封面：background-image 中被 http:/// 前缀伪装的 IPFS 链接
		const backgroundMatch = parent.querySelectorAll<HTMLElement>(
			'[style*="http:///ipfs://"], [style*="http:///internal.ipfs-locked:"]',
		);

		const jobs: Promise<void>[] = [];
		match.forEach((element) => {
			jobs.push(this.processElementURL(element));
		});
		backgroundMatch.forEach((element) => {
			jobs.push(this.processElementBackgroundImage(element));
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
		this.scriptLoader?.clearCache();

		// 保存时加载脚本以触发锁定（resolveURL 在加载路径中处理 HTTPS→CID 锁定）
		if (this.settings.preProcess.scriptURL) {
			try {
				await this.scriptLoader.loadScript(
					this.settings.preProcess.scriptURL,
				);
			} catch (err) {
				console.warn(`[saveSettings] Failed to preload script:`, err);
				new Notice(
					t("scriptLoadFailed")(this.settings.preProcess.scriptURL),
				);
			}
		}
	}

	onunload() {
		// 先释放管线持有的挂起日志定时器，再统一回收其余资源；
		// onload 未完成即被卸载时 pipeline 可能未赋值
		this.pipeline?.dispose();
		this.stack?.dispose();
	}
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		insertAttachment: "Insert attachment",
		migrateCurrentNote: "Migrate local files (current note)",
		lockCurrentNote: "Lock web files (current note)",
		lockLink: "Lock this link",
		unlockLink: "Unlock this link",
		encryptLink: "Encrypt this link",
		decryptLink: "Decrypt this link",
		loading: "Loading",
		fileNotFound: "File not found",
		openCASExplorer: "Open CAS file explorer",
		restoreReferencedFiles: "Restore referenced files from recycle bin",
		noReferencedFilesToRestore:
			"No referenced files to restore from the recycle bin.",
		...reprocessSharedMessages.en,
		reprocessLink: "Reprocess this attachment",
		noScriptConfigured: "No pre-processing script configured",
		scriptLoadFailed: (url: string) =>
			`Failed to load pre-processing script: ${url}`,
		httpsScriptLocked: (url: string) =>
			`HTTPS script locked to content: ${url}`,
	},
	zh: {
		insertAttachment: "插入附件",
		migrateCurrentNote: "迁移本地文件（当前笔记）",
		lockCurrentNote: "锁定网络文件（当前笔记）",
		lockLink: "锁定此链接",
		unlockLink: "解锁此链接",
		encryptLink: "加密此链接",
		decryptLink: "解密此链接",
		loading: "正在加载",
		fileNotFound: "未找到文件",
		openCASExplorer: "打开 CAS 文件管理器",
		restoreReferencedFiles: "从回收站恢复被引用的文件",
		noReferencedFilesToRestore: "未发现回收站中有需要恢复的引用文件。",
		...reprocessSharedMessages.zh,
		reprocessLink: "重新处理此附件",
		noScriptConfigured: "未配置预处理脚本",
		scriptLoadFailed: (url: string) => `预处理脚本加载失败：${url}`,
		httpsScriptLocked: (url: string) => `HTTPS 脚本已锁定内容：${url}`,
	},
});
//#endregion

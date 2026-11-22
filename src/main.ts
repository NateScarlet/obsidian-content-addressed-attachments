import { Notice, Plugin, TFile, MarkdownView } from "obsidian";
import MainPluginSettingTab from "./ui/MainPluginSettingTab";
import { MigrationManager } from "./MigrationManager";
import defineLocales from "./utils/defineLocales";
import { URLResolver } from "./URLResolver";
import {
	getDefaultSettings,
	getDownloadDirs,
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
import { markdownChange, casMetadataChanged } from "./events";
import { CASMetadataSyncService } from "./infrastructure/indexed-db/CASMetadataSyncService";
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
import { createCLIResolveHandler } from "./commands/resolveCLI";
import { enforceDownloadQuota } from "./commands/cleanDownloadDir";
import {
	createReprocessContext,
	reprocessCurrentNote,
	reprocessSharedMessages,
	reprocessSingleLinkCommand,
	reprocessWholeVault,
} from "./commands/reprocessAttachments";
import IPFSLink from "./utils/IPFSLink";
import findIPFSLinks from "./utils/findIPFSLinks";
import FailureImages from "./utils/FailureImages";
import KeyManager from "./lib/encryption/KeyManager";
import EncryptionService from "./lib/encryption/EncryptionService";
import EncryptPathPolicy from "./lib/encryption/EncryptPathPolicy";
import type { KeyStorage } from "./lib/encryption/types";
import type { SecretReader } from "./utils/renderHeaderValue";
import TransformPipeline from "./preprocess/TransformPipeline";
import DefaultScriptLoader from "./preprocess/ScriptLoader";
import type { ScriptLoader } from "./preprocess/types";
import createScriptLoaderOptions from "./preprocess/createScriptLoaderOptions";
import CoalescedNotice from "./utils/CoalescedNotice";
import PageLinkPatcher from "./PageLinkPatcher";

/** 页面补丁失败提示的合并窗口（毫秒） */
const PATCH_FAILURE_NOTICE_WINDOW_MS = 500;

/** 下载配额超限提示的合并窗口（毫秒） */
const QUOTA_NOTICE_WINDOW_MS = 500;

export default class ContentAddressedAttachmentPlugin extends Plugin {
	declare public settings: Settings;
	public cas!: CAS;
	public casMetadata!: CASMetadata;
	/** 后台索引追平服务：消费写侧失效信号，按磁盘真相批量落地元数据 */
	public metadataSyncService!: CASMetadataSyncService;
	/**
	 * 元数据写入专用中止信号：插件卸载（含热重载/升级）时中止进行中的批量写入，
	 * 避免插件多版本同时竞争写入同一 IndexedDB。
	 */
	public metadataWriteController = new AbortController();
	public urlResolver!: URLResolver;
	public referenceManager = new ReferenceManager({
		vault: this.app.vault,
		// cas / 元数据 / 设置在 onload 中创建或替换，按使用时求值注入
		getCas: () => this.cas,
		getCasMetadata: () => this.casMetadata,
		getSettings: () => this.settings,
	});
	public keyManager!: KeyManager;
	public encryptionService!: EncryptionService;
	public encryptPathPolicy!: EncryptPathPolicy;

	public get hasSecretStorage(): boolean {
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		return !!this.app.secretStorage;
	}

	private stack = new DisposableStack();
	/** 页面链接补丁失败提示：按 DOM 变动高频触发，合并为窗口内累计一条 */
	private readonly patchFailureNotice = this.stack.use(
		new CoalescedNotice(
			(count) => new Notice(t("patchFailed")(count)),
			PATCH_FAILURE_NOTICE_WINDOW_MS,
		),
	);
	/** 下载配额超限提示：批量下载时高频触发，合并为窗口内一条 */
	private readonly quotaExceededNotice = this.stack.use(
		new CoalescedNotice(
			(count) => new Notice(t("downloadQuotaExceeded")(count)),
			QUOTA_NOTICE_WINDOW_MS,
		),
	);
	public migrationManager!: MigrationManager;
	public lockManager!: LockManager;
	public pipeline!: TransformPipeline;
	public scriptLoader!: ScriptLoader;

	private placeholderImageURL!: string;
	/** 元素解析失败时的占位图；按错误自带的文案缓存并统一释放 */
	private readonly failureImages = this.stack.use(
		new FailureImages(t("fileNotFound")),
	);

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

		this.casMetadata = this.stack.use(
			new CASMetadataImpl(
				new CASMetadataObjectFilterBuilder(this.referenceManager),
			),
		);
		// 构建者负责清理：referenceManager 默认构建 ReferenceManagerCacheImpl，
		// 卸载时随 stack 关闭其 IndexedDB 连接（热重载不残留连接阻塞后续打开）
		this.stack.use(this.referenceManager);
		this.cas = new CASImpl(
			this.app,
			this.casMetadata,
			() => {
				return uniq([
					this.settings.primaryDir,
					...getDownloadDirs(this.settings),
				]);
			},
			{
				// CAS 落盘事实后仅发布失效信号，后台由 CASMetadataSyncService 消费追平。
				// CASImpl 不直接 await 元数据同步，避免 IndexedDB 忙时阻塞图片解析。
				notifyChanged: (signal) =>
					casMetadataChanged.dispatch({ detail: signal }),
			},
			// 写入策略：下载目录合计占用超配额时先清理再落盘。
			// 依赖本实例的回调在调用时才求值，构造顺序无关。
			async (dir, size) => {
				const result = await enforceDownloadQuota(
					this.cas,
					this.casMetadata,
					{
						targetDir: dir,
						downloadDir: this.settings.downloadDir,
						gateways: this.settings.gateways,
						quotaBytes: this.settings.downloadQuotaBytes,
						incomingBytes: size,
						retentionDays: this.settings.downloadRetentionDays,
						signal: this.metadataWriteController.signal,
					},
				);
				if (result.didExceedQuota) {
					// 保留期内的副本不可清理：写入照常进行，合并提示用户配额超限
					this.quotaExceededNotice.report(1);
				}
			},
		);
		this.metadataSyncService = new CASMetadataSyncService(
			this.cas,
			this.casMetadata,
			this.metadataWriteController.signal,
		);
		this.stack.use(this.metadataSyncService);
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
		// 出站 header 的 secret 读取能力：复用同一份 SecretStorage 封装，
		// 每次请求实时读取；这里的 secret 与加密密钥互不相干。
		const readSecret: SecretReader = (id) => storage.getSecret(id);
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
				readSecret,
			),
		);

		this.registerResolveCLIHandler();

		this.migrationManager = this.stack.use(
			new MigrationManager({
				app: this.app,
				cas: this.cas,
				getSettings: () => this.settings,
			}),
		);
		this.lockManager = this.stack.use(
			new LockManager({
				app: this.app,
				cas: this.cas,
				getSettings: () => this.settings,
				readSecret,
			}),
		);

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

		// 页面补丁状态机：入口只组装依赖并启动，卸载时随 stack 断开 observer
		this.stack
			.use(
				new PageLinkPatcher({
					resolveURL: (rawURL) => this.urlResolver.resolveURL(rawURL),
					placeholder: this.placeholderImageURL,
					failures: this.failureImages,
					notice: this.patchFailureNotice,
					document: activeDocument,
				}),
			)
			.start();

		this.registerEditorExtension(
			createIPFSLinkClickExtension(this.urlResolver),
		);

		this.addSettingTab(
			new MainPluginSettingTab({
				app: this.app,
				plugin: this,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
				hasSecretStorage: this.hasSecretStorage,
				urlResolver: this.urlResolver,
				keyManager: this.keyManager,
				encryptionService: this.encryptionService,
				cas: this.cas,
				referenceManager: this.referenceManager,
				encryptPathPolicy: this.encryptPathPolicy,
				migrationManager: this.migrationManager,
				lockManager: this.lockManager,
				pipeline: this.pipeline,
			}),
		);

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
			this.app.workspace.on("editor-change", (_editor, view) => {
				if (view.file && view.file.extension === "md") {
					// 仅用于刷新界面的当前笔记内容；引用索引统一由 modify→loadFile 以磁盘内容重建，
					// 不以编辑器缓冲喂索引，避免未保存的临时状态影响引用判定（见 CODING_STANDARDS #9 与 #41）
					markdownChange.dispatch({ detail: view.file });
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
						encryptPathPolicy: this.encryptPathPolicy,
						keyManager: this.keyManager,
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
				restoreReferencedFiles(this.cas, this.casMetadata, {
					referenceManager: this.referenceManager,
					primaryDir: this.settings.primaryDir,
					downloadDirs: getDownloadDirs(this.settings),
				})
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
			(leaf) =>
				new CASFileExplorerView(leaf, {
					app: this.app,
					cas: this.cas,
					casMetadata: this.casMetadata,
					referenceManager: this.referenceManager,
					encryptionService: this.encryptionService,
					metadataWriteSignal: this.metadataWriteController.signal,
					getPrimaryDir: () => this.settings.primaryDir,
					getDownloadDirs: () => getDownloadDirs(this.settings),
					getDownloadRetentionDays: () =>
						this.settings.downloadRetentionDays,
					setDownloadRetentionDays: async (days: number) => {
						this.settings.downloadRetentionDays = days;
						await this.saveSettings();
					},
				}),
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
	}

	/** 注册原生 CLI 子命令；旧版 Obsidian 没有该 API 时跳过，不影响插件加载 */
	private registerResolveCLIHandler(): void {
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		if (typeof this.registerCliHandler !== "function") return;
		// eslint-disable-next-line obsidianmd/no-unsupported-api
		this.registerCliHandler(
			"content-addressed-attachments:resolve",
			t("cliResolveDescription"),
			{
				url: {
					value: "<url>",
					description: t("cliResolveURLDescription"),
					required: true,
				},
			},
			createCLIResolveHandler({
				resolveURL: (rawURL) => this.urlResolver.resolveURL(rawURL),
				getFullPath: (path) => {
					// getFullPath 不在 DataAdapter 基础契约上，由桌面/移动端实现提供
					const adapter = this.app.vault
						.adapter as typeof this.app.vault.adapter & {
						getFullPath?: (normalizedPath: string) => string;
					};
					if (typeof adapter.getFullPath !== "function") {
						throw new Error(
							"CLI resolve requires an adapter with getFullPath support",
						);
					}
					return adapter.getFullPath(path);
				},
				getMaxBlobSize: () => this.settings.maxBlobSize,
			}),
		);
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
		// 先中止进行中的元数据写入，再释放其余资源
		this.metadataWriteController.abort();
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
		patchFailed: (count: number) =>
			`Failed to resolve ${count} IPFS link(s) on this page.`,
		downloadQuotaExceeded: (count: number) =>
			`Download directories stayed over quota after cleanup (${count} write(s)); copies within the retention period cannot be cleaned.`,
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
		cliResolveDescription:
			"Resolve an attachment URL and output its content as JSON (ipfs:// or internal.ipfs-locked:)",
		cliResolveURLDescription:
			"Attachment URL to resolve (ipfs:// or internal.ipfs-locked:)",
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
		patchFailed: (count: number) =>
			`页面上有 ${count} 个 IPFS 链接解析失败。`,
		downloadQuotaExceeded: (count: number) =>
			`下载目录清理后仍超过配额（${count} 次写入）：保留期内的副本无法清理。`,
		restoreReferencedFiles: "从回收站恢复被引用的文件",
		noReferencedFilesToRestore: "未发现回收站中有需要恢复的引用文件。",
		...reprocessSharedMessages.zh,
		reprocessLink: "重新处理此附件",
		noScriptConfigured: "未配置预处理脚本",
		scriptLoadFailed: (url: string) => `预处理脚本加载失败：${url}`,
		httpsScriptLocked: (url: string) => `HTTPS 脚本已锁定内容：${url}`,
		cliResolveDescription:
			"解析附件 URL 并以 JSON 输出其内容（支持 ipfs:// 与 internal.ipfs-locked:）",
		cliResolveURLDescription:
			"要解析的附件 URL（ipfs:// 或 internal.ipfs-locked:）",
	},
});
//#endregion

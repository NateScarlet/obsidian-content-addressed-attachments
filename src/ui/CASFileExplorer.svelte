<script module lang="ts">
	import defineLocales from "../utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			confirmPermanentDelete: (filename: string) =>
				`Permanently delete "${filename}"? This action cannot be undone.`,
			confirmEmptyTrash: (count: number) =>
				`Permanently delete ${count} files from trash? This action cannot be undone.`,
			confirmCleanUnreferenced: (count: number) =>
				`Move ${count} unreferenced files to trash?`,
			indexRebuilt: "Index rebuilt successfully",
			operationFailed: "Operation failed",
		},
		zh: {
			confirmPermanentDelete: (filename: string) =>
				`永久删除"${filename}"？此操作无法撤销。`,
			confirmEmptyTrash: (count: number) =>
				`永久删除回收站中的 ${count} 个文件？此操作无法撤销。`,
			confirmCleanUnreferenced: (count: number) =>
				`将 ${count} 个未引用文件移至回收站？`,
			indexRebuilt: "索引重建成功",
			operationFailed: "操作失败",
		},
	});
	//#endregion

	// 创建 Context 类型
	interface CASFileExplorerContext {
		// 依赖
		cas: CAS;
		casMetadata: CASMetadata;
		app: App;

		// 状态
		mode: { value: Mode };
		query: { value: string };
		loading: { readonly value: boolean };
		files: { readonly value: FileItem[] };
		hasNextPage: { readonly value: boolean };

		// 操作方法
		loadFiles: (reset?: boolean) => Promise<void>;
		emptyTrash: () => Promise<void>;
		cleanUnreferenced: () => Promise<void>;
		rebuildIndex: () => Promise<void>;
		trashFile: (cid: CID) => Promise<void>;
		deleteFile: (cid: CID, filename: string) => Promise<void>;
		goToReference: (cid: CID) => Promise<void>;
	}

	// 创建

	const [getContext, setContext] = createContext<CASFileExplorerContext>();

	export enum Mode {
		ALL,
		UNREFERENCED,
		TRASHED,
	}

	export { getContext };

	const PAGE_SIZE = 50;
</script>

<script lang="ts">
	import { createContext } from "svelte";
	import { CID } from "multiformats/cid";
	import { MarkdownView, Notice, type App } from "obsidian";
	import type { CASMetadata, CASMetadataObject } from "src/types/CASMetadata";
	import type { CAS } from "src/types/CAS";
	import ReferenceManager from "src/ReferenceManager";
	import rebuildCASMetadata from "src/commands/rebuildCASMetadata";
	import castError from "src/utils/castError";
	import CASFileExplorerHeader from "./CASFileExplorerHeader.svelte";
	import CASFileExplorerViewTabs from "./CASFileExplorerViewTabs.svelte";
	import CASFileExplorerTable from "./CASFileExplorerTable.svelte";
	import { casMetadataSaved } from "src/events";
	import replaceArrayItemBy from "src/utils/replaceArrayItemBy";

	// 定义文件项接口（移除方法）
	export interface FileItem {
		cid: CID;
		filename: string;
		format: string;
		size: number;
		indexedAt: Date;
		references: number;
		trashedAt?: Date;
	}

	// Props
	let {
		app,
		referenceManager,
		cas,
		casMetadata,
	}: {
		app: App;
		referenceManager: ReferenceManager;
		cas: CAS;
		casMetadata: CASMetadata;
	} = $props();

	// 状态
	let currentView = $state<Mode>(Mode.ALL);
	let searchQuery = $state("");
	let isLoading = $state(false);
	let nextCursor = $state<string>();

	// 文件列表
	let files = $state<FileItem[]>([]);

	// 过滤后的文件列表
	const filteredFiles = $derived.by(() => {
		let result = files;

		// 根据视图过滤
		if (currentView === Mode.TRASHED) {
			result = result.filter((file) => !!file.trashedAt);
		} else if (currentView === Mode.UNREFERENCED) {
			result = result.filter(
				(file) => file.references === 0 && !file.trashedAt,
			);
		}

		// 根据搜索查询过滤
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase().trim();
			result = result.filter(
				(file) =>
					file.filename.toLowerCase().includes(query) ||
					file.format.toLowerCase().includes(query),
			);
		}

		return result;
	});

	// 文件操作方法
	async function trashFile(cid: CID) {
		try {
			await cas.trash(cid);
		} catch (error) {
			console.error("Failed to move file to trash:", error);
			new Notice(t("operationFailed"));
		}
	}

	async function deleteFile(cid: CID, filename: string) {
		if (!confirm(t("confirmPermanentDelete")(filename))) return;

		try {
			await cas.delete(cid);
			// 从列表中移除
			files = files.filter((f) => f.cid.equals(cid));
		} catch (error) {
			console.error("Failed to delete file:", error);
			new Notice(t("operationFailed"));
		}
	}

	async function goToReference(cid: CID) {
		for await (const i of referenceManager.findReference(cid)) {
			// 打开文件
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(i.file);

			const view = leaf.view;
			if (view instanceof MarkdownView) {
				const editor = view.editor;
				const range = {
					from: editor.offsetToPos(i.pos[0]),
					to: editor.offsetToPos(i.pos[1]),
				};
				editor.setSelection(range.from, range.to);
				editor.scrollIntoView(range, true);
			}
			break; // 只跳转到第一个引用
		}
	}
	let hasNextPage = $state(false);

	async function loadFile(obj: CASMetadataObject) {
		// 获取引用计数
		const referenceCount = await referenceManager.count(obj.cid, 100);

		let filename = obj.filename ?? "";
		let format = obj.format ?? "";

		// 基于实际引用获取缺少的文件名和格式
		if (!filename || !format) {
			for await (const { url, title } of referenceManager.findReference(
				obj.cid,
			)) {
				filename = filename || url.filename || title || "";
				format = format || url.format || "";
				if (filename && format) {
					break;
				}
			}
		}

		files = replaceArrayItemBy(
			files,
			(i) => i.cid.equals(obj.cid),
			{
				cid: obj.cid,
				filename,
				format,
				size: obj.size || 0,
				indexedAt: obj.indexedAt,
				references: referenceCount,
				trashedAt: obj.trashedAt,
			},
			{ whenNoMatch: "prepend" },
		);
	}

	// 加载文件
	async function loadFiles(reset: boolean = true) {
		if (reset) {
			files = [];
			nextCursor = undefined;
			hasNextPage = false;
		}

		if (isLoading) return;
		isLoading = true;

		try {
			const filterBy: { query?: string; isTrashed?: boolean } = {};

			if (currentView === Mode.TRASHED) {
				filterBy.isTrashed = true;
			} else if (currentView === Mode.UNREFERENCED) {
				filterBy.isTrashed = false;
			}

			if (searchQuery.trim()) {
				filterBy.query = searchQuery.trim();
			}

			let matchCount = 0;

			// 流式读取，逐个处理文件
			for await (const { node, cursor } of casMetadata.find(
				filterBy,
				reset ? undefined : nextCursor,
			)) {
				await loadFile(node);

				matchCount++;
				nextCursor = cursor;

				// 达到分页大小时立即停止，保留游标用于下一页
				if (matchCount >= PAGE_SIZE) {
					break;
				}
			}

			hasNextPage = matchCount >= PAGE_SIZE;
		} catch (error) {
			console.error("Failed to load files:", error);
			new Notice(t("operationFailed") + "\n" + castError(error).message);
		} finally {
			isLoading = false;
		}
	}

	// 批量操作函数
	async function emptyTrash() {
		const trashedFiles = files.filter((f) => f.trashedAt);
		if (trashedFiles.length === 0) return;

		if (!confirm(t("confirmEmptyTrash")(trashedFiles.length))) return;

		try {
			for (const file of trashedFiles) {
				await cas.delete(file.cid);
			}
			// 从列表中移除所有已删除的文件
			files = files.filter((f) => !f.trashedAt);
		} catch (error) {
			console.error("Failed to empty trash:", error);
			new Notice(t("operationFailed"));
		}
	}

	async function cleanUnreferenced() {
		const unreferencedFiles = files.filter(
			(f) => f.references === 0 && !f.trashedAt,
		);
		if (unreferencedFiles.length === 0) return;

		if (!confirm(t("confirmCleanUnreferenced")(unreferencedFiles.length)))
			return;

		try {
			for (const file of unreferencedFiles) {
				const success = await cas.trash(file.cid);
				if (success) {
					const index = files.findIndex(
						(f) => f.cid.toString() === file.cid.toString(),
					);
					if (index !== -1) {
						files[index].trashedAt = new Date();
					}
				}
			}
		} catch (error) {
			console.error("Failed to clean unreferenced files:", error);
			new Notice(t("operationFailed"));
		}
	}

	async function rebuildIndex() {
		try {
			await rebuildCASMetadata(casMetadata, cas.objects());
			await referenceManager.clearCache();
			await loadFiles(true);
			new Notice(t("indexRebuilt"));
		} catch (error) {
			console.error("Failed to rebuild index:", error);
			new Notice(t("operationFailed") + "\n" + castError(error).message);
		}
	}

	loadFiles(true);

	// 提供 context
	setContext({
		cas,
		casMetadata,
		app,
		mode: {
			get value() {
				return currentView;
			},
			set value(v) {
				currentView = v;
			},
		},
		query: {
			get value() {
				return searchQuery;
			},
			set value(v) {
				searchQuery = v;
			},
		},

		loading: {
			get value() {
				return isLoading;
			},
		},
		files: {
			get value() {
				return filteredFiles;
			},
		},
		hasNextPage: {
			get value() {
				return hasNextPage;
			},
		},
		loadFiles,
		emptyTrash,
		cleanUnreferenced,
		rebuildIndex,
		trashFile,
		deleteFile,
		goToReference,
	});

	$effect(() => {
		return casMetadataSaved.subscribe((e) => {
			void loadFile(e.detail);
		});
	});
</script>

<div class="h-full flex flex-col cas-file-explorer">
	<CASFileExplorerHeader />
	<CASFileExplorerViewTabs />
	<CASFileExplorerTable />
</div>

<script module lang="ts">
	const PAGE_SIZE = 50;
	const SKELETON_ITEMS = Array.from({ length: PAGE_SIZE }, (_, i) => i);
	/** 批量保存事件的应用最小间隔（毫秒），限制列表重渲染频率 */
	const BATCH_APPLY_INTERVAL_MS = 1000;
</script>

<script lang="ts">
	import { getAbortSignal, untrack } from "svelte";
	import { setContext, Mode } from "./CASFileExplorerContext";
	import { type App } from "obsidian";
	import type {
		CASMetadata,
		CASMetadataObject,
		CASMetadataObjectFilters,
	} from "#src/types/CASMetadata";
	import type { CAS } from "#src/types/CAS";
	import ReferenceManager from "#src/ReferenceManager";
	import CASFileExplorerHeader from "./CASFileExplorerHeader.svelte";
	import CASFileExplorerViewTabs from "./CASFileExplorerTabs.svelte";
	import CASFileExplorerGrid from "./CASFileExplorerGrid.svelte";
	import {
		casMetadataDelete,
		casMetadataSave,
		casMetadataBatchSave,
	} from "#src/events";
	import replaceArrayItemBy from "#src/utils/replaceArrayItemBy";
	import useActiveNoteContent from "./stores/useActiveNoteContent.svelte";
	import findIPFSLinks from "#src/utils/findIPFSLinks";
	import staleWithRevalidate from "./stores/staleWhileRevalidate.svelte";

	import type EncryptionService from "./encryption/EncryptionService";

	// Props
	let {
		app,
		referenceManager,
		cas,
		casMetadata,
		encryptionService,
		metadataWriteSignal,
		getPrimaryDir,
		getDownloadDirs,
	}: {
		app: App;
		referenceManager: ReferenceManager;
		cas: CAS;
		casMetadata: CASMetadata;
		encryptionService: EncryptionService;
		metadataWriteSignal: AbortSignal;
		getPrimaryDir: () => string;
		getDownloadDirs: () => string[];
	} = $props();

	// 状态
	let mode = $state<Mode>(Mode.LOCAL);
	let query = $state("");

	let activeNoteContent = useActiveNoteContent(
		untrack(() => app),
		() => mode === Mode.ACTIVE_NOTE,
	);

	const filterBy = $derived.by((): CASMetadataObjectFilters => {
		switch (mode) {
			case Mode.LOCAL:
				return {
					query,
					isTrashed: false,
				};
			case Mode.ACTIVE_NOTE:
				return {
					query,
					cid: Array.from(findIPFSLinks($activeNoteContent)).map(
						(i) => i.url.cid,
					),
				};
			case Mode.UNREFERENCED:
				return {
					query,
					hasReference: false,
					isTrashed: false,
				};
			case Mode.RECYCLE_BIN:
				return {
					query,
					isTrashed: true,
				};
		}
	});

	// 文件列表
	let { result: files } = staleWithRevalidate(() => {
		void filterBy;
		return loadPage(getAbortSignal());
	});

	async function loadPage(signal?: AbortSignal, after?: string) {
		let matchCount = 0;
		let endCursor = "";
		const nodes: CASMetadataObject[] = [];
		for await (const { node, cursor } of casMetadata.find({
			filterBy,
			after,
			signal,
		})) {
			matchCount++;
			nodes.push(node);
			endCursor = cursor;
			if (matchCount === PAGE_SIZE) {
				break;
			}
		}
		hasNextPage = matchCount >= PAGE_SIZE;
		return {
			nodes,
			endCursor,
			hasNextPage,
		};
	}

	async function fetchMore(signal?: AbortSignal) {
		if (!$files) {
			return;
		}
		const { nodes, endCursor } = $files;

		const more = await loadPage(signal, endCursor);
		$files = {
			...more,
			nodes: [...nodes, ...more.nodes],
		};
	}

	let hasNextPage = $state(false);

	// 提供 context
	// 依赖服务实例（referenceManager/app/encryptionService）为稳定引用，仅在初始化时读取；
	// getPrimaryDir/getDownloadDirs 为设置读取函数，调用时实时取当前设置
	setContext(
		untrack(() => ({
			cas,
			casMetadata,
			referenceManager,
			app,
			encryptionService,
			metadataWriteSignal,
			getPrimaryDir,
			getDownloadDirs,
			mode: {
				get value() {
					return mode;
				},
				set value(v) {
					mode = v;
				},
			},
			query: {
				get value() {
					return query;
				},
				set value(v) {
					query = v;
				},
			},
			fetchMore,
		})),
	);

	// 单条保存事件：立即应用（保存/回收等低频写入路径，与批量事件并存互不替代）
	$effect(() => {
		return casMetadataSave.subscribe((e) => {
			if (!$files) {
				return;
			}
			const { nodes, ...rest } = $files;
			$files = {
				...rest,
				nodes: replaceArrayItemBy(
					nodes,
					(i) => i.cid.equals(e.detail.cid),
					e.detail,
					{ whenNoMatch: "ignore" },
				),
			};
		});
	});

	// 批量保存事件（重建索引等批量写入路径）：按 1 秒最小间隔应用聚合变更，
	// 避免逐事件整表替换重渲染把主线程渲染帧饿死（进度条不刷新的根因）
	$effect(() => {
		let pending: CASMetadataObject[] | undefined;
		let timer: number | undefined;
		const apply = () => {
			timer = undefined;
			if (!pending || !$files) {
				return;
			}
			const changes = pending;
			pending = undefined;
			const { nodes, ...rest } = $files;
			let next = nodes;
			for (const detail of changes) {
				next = replaceArrayItemBy(
					next,
					(i) => i.cid.equals(detail.cid),
					detail,
					{ whenNoMatch: "ignore" },
				);
			}
			$files = { ...rest, nodes: next };
		};
		return casMetadataBatchSave.subscribe((e) => {
			pending = [...(pending ?? []), ...e.detail];
			timer ??= window.setTimeout(apply, BATCH_APPLY_INTERVAL_MS);
		});
	});
	$effect(() => {
		return casMetadataDelete.subscribe((e) => {
			if (!$files) {
				return;
			}
			const { nodes, ...rest } = $files;
			$files = {
				...rest,
				nodes: nodes.filter((i) => !i.cid.equals(e.detail.cid)),
			};
		});
	});
</script>

<div class="h-full flex flex-col gap-1 @container">
	<CASFileExplorerHeader />
	<CASFileExplorerViewTabs />
	{#if $files}
		<CASFileExplorerGrid files={$files} />
	{:else}
		<div
			class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-px gap-y-2 p-px @sm:gap-1 @sm:p-1 @md:gap-2 @md:p-2"
		>
			{#each SKELETON_ITEMS as i (i)}
				<div class="h-64 bg-hover animate-pulse rounded"></div>
			{/each}
		</div>
	{/if}
</div>

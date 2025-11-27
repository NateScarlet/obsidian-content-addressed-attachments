<script module lang="ts">
	// 创建 Context 类型
	interface CASFileExplorerContext {
		// 依赖
		cas: CAS;
		casMetadata: CASMetadata;
		referenceManager: ReferenceManager;
		app: App;

		// 状态
		mode: { value: Mode };
		query: { value: string };

		fetchMore(): Promise<void>;
	}

	// 创建

	const [getContext, setContext] = createContext<CASFileExplorerContext>();

	export enum Mode {
		ALL,
		ACTIVE_NOTE,
		UNREFERENCED,
		RECYCLE_BIN,
	}

	export { getContext };

	const PAGE_SIZE = 50;
</script>

<script lang="ts">
	import { createContext, getAbortSignal } from "svelte";
	import { type App } from "obsidian";
	import type {
		CASMetadata,
		CASMetadataObject,
		CASMetadataObjectFilters,
	} from "src/types/CASMetadata";
	import type { CAS } from "src/types/CAS";
	import ReferenceManager from "src/ReferenceManager";
	import CASFileExplorerHeader from "./CASFileExplorerHeader.svelte";
	import CASFileExplorerViewTabs from "./CASFileExplorerTabs.svelte";
	import CASFileExplorerGrid from "./CASFileExplorerGrid.svelte";
	import { casMetadataDelete, casMetadataSave } from "src/events";
	import replaceArrayItemBy from "src/utils/replaceArrayItemBy";
	import useActiveNoteContent from "./stores/useActiveNoteContent.svelte";
	import findIPFSLinks from "src/utils/findIPFSLinks";
	import staleWithRevalidate from "./stores/staleWhileRevalidate.svelte";

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
	let mode = $state<Mode>(Mode.ALL);
	let query = $state("");

	let activeNoteContent = useActiveNoteContent(
		app,
		() => mode === Mode.ACTIVE_NOTE,
	);

	const filterBy = $derived.by((): CASMetadataObjectFilters => {
		switch (mode) {
			case Mode.ALL:
				return {
					query,
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
	setContext({
		cas,
		casMetadata,
		referenceManager,
		app,
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
	});

	$effect(() => {
		return casMetadataSave.subscribe(async (e) => {
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
	$effect(() => {
		return casMetadataDelete.subscribe(async (e) => {
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
			{#each Array.from({ length: PAGE_SIZE }) as i (i)}
				<div class="h-64 bg-hover animate-pulse rounded"></div>
			{/each}
		</div>
	{/if}
</div>

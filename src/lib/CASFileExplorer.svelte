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
		UNREFERENCED,
		TRASHED,
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
	import CASFileExplorerViewTabs from "./CASFileExplorerViewTabs.svelte";
	import CASFileExplorerGrid from "./CASFileExplorerGrid.svelte";
	import { casMetadataDelete, casMetadataSave } from "src/events";
	import replaceArrayItemBy from "src/utils/replaceArrayItemBy";

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
	let query = $state("");

	const filterBy = $derived.by((): CASMetadataObjectFilters => {
		switch (currentView) {
			case Mode.ALL:
				return {
					query,
				};
			case Mode.UNREFERENCED:
				return {
					hasReference: false,
					isTrashed: false,
				};
			case Mode.TRASHED:
				return {
					isTrashed: true,
				};
		}
	});

	// 文件列表
	let files = $derived.by(() => {
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
		const { nodes, endCursor } = await files;

		const more = await loadPage(signal, endCursor);
		files = Promise.resolve({
			...more,
			nodes: [...nodes, ...more.nodes],
		});
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
				return currentView;
			},
			set value(v) {
				currentView = v;
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
			const { nodes, ...rest } = await files;
			files = Promise.resolve({
				...rest,
				nodes: replaceArrayItemBy(
					nodes,
					(i) => i.cid.equals(e.detail.cid),
					e.detail,
					{ whenNoMatch: "ignore" },
				),
			});
		});
	});
	$effect(() => {
		return casMetadataDelete.subscribe(async (e) => {
			const { nodes, ...rest } = await files;
			files = Promise.resolve({
				...rest,
				nodes: nodes.filter((i) => !i.cid.equals(e.detail.cid)),
			});
		});
	});
</script>

<div class="h-full flex flex-col gap-1 @container">
	<CASFileExplorerHeader />
	<CASFileExplorerViewTabs />
	{#await files}
		<div
			class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-px gap-y-2 p-px @sm:gap-1 @sm:p-1 @md:gap-2 @md:p-2"
		>
			{#each Array.from({ length: PAGE_SIZE }) as i (i)}
				<div class="h-64 bg-hover animate-pulse rounded"></div>
			{/each}
		</div>
	{:then files}
		<CASFileExplorerGrid {files} />
	{/await}
</div>

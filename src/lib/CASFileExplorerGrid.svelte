<script module lang="ts">
	import type { CASMetadataObject } from "src/types/CASMetadata";
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			noFiles: "No files found",
			loadMore: "Load More",
		},
		zh: {
			noFiles: "未找到文件",
			loadMore: "加载更多",
		},
	});
</script>

<script lang="ts">
	import { getContext } from "./CASFileExplorer.svelte";
	import CASFileExplorerGridItem from "./CASFileExplorerGridItem.svelte";
	import infiniteScroll from "./attachments/infiniteScroll";

	const {
		files,
	}: {
		files: {
			nodes: CASMetadataObject[];
			hasNextPage: boolean;
		};
	} = $props();
	const { fetchMore } = getContext();
</script>

<div class="flex-1 overflow-auto" {@attach infiniteScroll({ fetchMore })}>
	<!-- 卡片网格布局 -->
	<div
		class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-px gap-y-2 p-px @sm:gap-1 @sm:p-1 @md:gap-2 @md:p-2"
	>
		{#if files.nodes.length === 0}
			<div class="col-span-full p-8 text-center text-muted">
				{t("noFiles")}
			</div>
		{:else}
			{#each files.nodes as file (file.cid.toString())}
				<CASFileExplorerGridItem {file} />
			{/each}
		{/if}
	</div>

	<!-- 加载更多 -->
	{#if files.hasNextPage}
		<div class="text-center border-t border-border">
			<button
				class="px-4 py-2 bg-interactive-normal text-on-accent rounded hover:bg-interactive-hover"
				onclick={() => fetchMore()}
			>
				{t("loadMore")}
			</button>
		</div>
	{/if}
</div>

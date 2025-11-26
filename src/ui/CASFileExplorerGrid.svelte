<script module lang="ts">
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			loading: "Loading...",
			noFiles: "No files found",
			loadMore: "Load More",
		},
		zh: {
			loading: "加载中...",
			noFiles: "未找到文件",
			loadMore: "加载更多",
		},
	});
</script>

<script lang="ts">
	import { getContext } from "./CASFileExplorer.svelte";
	import CASFileExplorerGrid from "./CASFileExplorerGridItem.svelte";

	const { loadFiles, hasNextPage, loading, files } = getContext();
</script>

<div class="flex-1 overflow-auto">
	<!-- 卡片网格布局 -->
	<div
		class="grid grid-cols-[repeat(auto-fill,minmax(min(14rem,100%),1fr))] gap-px gap-y-2 p-px @sm:gap-1 @sm:p-1 @md:gap-2 @md:p-2"
	>
		{#if loading.value && files.value.length === 0}
			<div class="col-span-full p-8 text-center text-muted">
				{t("loading")}
			</div>
		{:else if files.value.length === 0}
			<div class="col-span-full p-8 text-center text-muted">
				{t("noFiles")}
			</div>
		{:else}
			{#each files.value as file (file.cid.toString())}
				<CASFileExplorerGrid {file} />
			{/each}
		{/if}
	</div>

	<!-- 加载更多 -->
	{#if hasNextPage.value && !loading.value}
		<div class="text-center border-t border-border">
			<button
				class="px-4 py-2 bg-interactive-normal text-on-accent rounded hover:bg-interactive-hover"
				onclick={() => loadFiles(false)}
				disabled={loading.value}
			>
				{t("loadMore")}
			</button>
		</div>
	{/if}
</div>

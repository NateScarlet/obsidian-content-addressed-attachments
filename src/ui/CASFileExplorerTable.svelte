<script module lang="ts">
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			filename: "Filename",
			format: "Format",
			size: "Size",
			indexedAt: "Indexed",
			references: "References",
			actions: "Actions",
			loading: "Loading...",
			noFiles: "No files found",
			file: "File",
			files: "Files",
			loadMore: "Load More",
		},
		zh: {
			filename: "文件名",
			format: "格式",
			size: "大小",
			indexedAt: "索引时间",
			references: "引用",
			actions: "操作",
			loading: "加载中...",
			noFiles: "未找到文件",
			file: "文件",
			files: "文件",
			loadMore: "加载更多",
		},
	});
</script>

<script lang="ts">
	import { getContext } from "./CASFileExplorer.svelte";
	import CASFileExplorerRow from "./CASFileExplorerRow.svelte";

	const { loadFiles, hasNextPage, loading, files } = getContext();
</script>

<div class="flex-1 overflow-auto">
	<table class="w-full text-sm">
		<thead class="sticky top-0 bg-secondary border-b border-border">
			<tr>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("filename")}</th
				>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("format")}</th
				>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("size")}</th
				>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("indexedAt")}</th
				>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("references")}</th
				>
				<th class="text-left p-3 font-semibold text-normal"
					>{t("actions")}</th
				>
			</tr>
		</thead>
		<tbody>
			{#if loading.value && files.value.length === 0}
				<tr>
					<td colspan="6" class="p-8 text-center text-muted">
						{t("loading")}
					</td>
				</tr>
			{:else if files.value.length === 0}
				<tr>
					<td colspan="6" class="p-8 text-center text-muted">
						{t("noFiles")}
					</td>
				</tr>
			{:else}
				{#each files.value as file (file.cid.toString())}
					<CASFileExplorerRow {file} />
				{/each}
			{/if}
		</tbody>
	</table>

	<!-- 加载更多 -->
	{#if hasNextPage.value && !loading.value}
		<div class="p-4 text-center border-t border-border">
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

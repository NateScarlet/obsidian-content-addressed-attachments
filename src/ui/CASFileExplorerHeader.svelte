<script module lang="ts">
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";

	const { t } = defineLocales({
		en: {
			searchPlaceholder: "Search files...",
			emptyTrash: "Empty Trash",
			cleanUnreferenced: "Clean Unreferenced Files",
			rebuildIndex: "Rebuild Index",
		},
		zh: {
			searchPlaceholder: "搜索文件...",
			emptyTrash: "清空回收站",
			cleanUnreferenced: "清理未引用文件",
			rebuildIndex: "重建索引",
		},
	});
</script>

<script lang="ts">
	const { query, mode, emptyTrash, cleanUnreferenced, rebuildIndex } =
		getContext();
</script>

<div class="flex items-center gap-1 flex-wrap">
	<!-- 搜索框 -->
	<input
		type="text"
		class="flex-1 py-1 border border-border rounded text-sm bg-form-field text-normal"
		placeholder={t("searchPlaceholder")}
		bind:value={query.value}
	/>

	<!-- 操作按钮 -->
	{#if mode.value === Mode.ALL}
		<button type="button" class="flex-none" onclick={rebuildIndex}>
			{t("rebuildIndex")}
		</button>
	{:else if mode.value === Mode.TRASHED}
		<button type="button" class="flex-none" onclick={emptyTrash}>
			{t("emptyTrash")}
		</button>
	{:else if mode.value === Mode.UNREFERENCED}
		<button type="button" class="flex-none" onclick={cleanUnreferenced}>
			{t("cleanUnreferenced")}
		</button>
	{/if}
</div>

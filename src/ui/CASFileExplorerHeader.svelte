<script module lang="ts">
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";

	const { t } = defineLocales({
		en: {
			casFileExplorer: "CAS File Explorer",
			searchPlaceholder: "Search files...",
			emptyTrash: "Empty Trash",
			cleanUnreferenced: "Clean Unreferenced Files",
			rebuildIndex: "Rebuild Index",
		},
		zh: {
			casFileExplorer: "CAS 文件管理器",
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

<div class="flex items-center justify-between p-4 border-b border-border">
	<h2 class="text-lg font-semibold text-normal m-0">
		{t("casFileExplorer")}
	</h2>

	<div class="flex items-center gap-2">
		<!-- 搜索框 -->
		<input
			type="text"
			class="flex-1 px-3 py-1 border border-border rounded text-sm bg-form-field text-normal"
			placeholder={t("searchPlaceholder")}
			bind:value={query.value}
		/>

		<!-- 操作按钮 -->
		<div class="flex gap-2">
			{#if mode.value === Mode.TRASHED}
				<button
					class="px-3 py-1 bg-error text-on-accent rounded text-sm hover:bg-error/80"
					onclick={emptyTrash}
				>
					{t("emptyTrash")}
				</button>
			{:else if mode.value === Mode.UNREFERENCED}
				<button
					class="px-3 py-1 bg-warning text-on-accent rounded text-sm hover:bg-warning/80"
					onclick={cleanUnreferenced}
				>
					{t("cleanUnreferenced")}
				</button>
			{/if}

			<button
				class="px-3 py-1 bg-interactive-normal text-on-accent rounded text-sm hover:bg-interactive-hover"
				onclick={rebuildIndex}
			>
				{t("rebuildIndex")}
			</button>
		</div>
	</div>
</div>

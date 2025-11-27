<script module lang="ts">
	import showError from "src/utils/showError";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";
	import rebuildCASMetadata from "src/commands/rebuildCASMetadata";

	const { t } = defineLocales({
		en: {
			searchPlaceholder: "Search files...",
			emptyTrash: "Empty Trash",
			cleanUnreferenced: "Clean Unreferenced Files",
			rebuildIndex: "Rebuild Index",
			confirmEmptyTrash: `Permanently delete ALL files from trash? This action cannot be undone.`,
		},
		zh: {
			searchPlaceholder: "搜索文件...",
			emptyTrash: "清空回收站",
			cleanUnreferenced: "清理未引用文件",
			rebuildIndex: "重建索引",
			confirmEmptyTrash: `永久删除回收站中的所有个文件？此操作无法撤销。`,
		},
	});
</script>

<script lang="ts">
	const { cas, casMetadata, referenceManager, query, mode } = getContext();

	async function cleanUnreferenced() {
		for await (const { node } of casMetadata.find({
			filterBy: {
				hasReference: false,
			},
			signal: undefined,
		})) {
			await cas.trash(node.cid);
		}
	}

	async function rebuildIndex() {
		await rebuildCASMetadata(casMetadata, cas.objects());
		await referenceManager.clearCache();
	}

	async function emptyTrash() {
		for await (const { node } of casMetadata.find({
			filterBy: {
				isTrashed: true,
			},
			signal: undefined,
		})) {
			await cas.deleteIfTrashed(node.cid);
		}
	}
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
		<button
			type="button"
			class="flex-none"
			onclick={() => rebuildIndex().catch(showError)}
		>
			{t("rebuildIndex")}
		</button>
	{:else if mode.value === Mode.RECYCLE_BIN}
		<button
			type="button"
			class="flex-none"
			onclick={() => emptyTrash().catch(showError)}
		>
			{t("emptyTrash")}
		</button>
	{:else if mode.value === Mode.UNREFERENCED}
		<button
			type="button"
			class="flex-none"
			onclick={() => cleanUnreferenced().catch(showError)}
		>
			{t("cleanUnreferenced")}
		</button>
	{/if}
</div>

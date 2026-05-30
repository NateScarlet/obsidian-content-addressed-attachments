<script module lang="ts">
	import showError from "src/utils/showError";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";

	const { t } = defineLocales({
		en: {
			searchPlaceholder: "Search files...",
			emptyTrash: "Empty trash",
			cleanUnreferenced: "Clean unreferenced files",
			rebuildIndex: "Rebuild index",
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
	import showProgress from "src/utils/showProgress";
	import emptyTrashCmd from "src/commands/emptyTrash";

	const { cas, casMetadata, referenceManager, query, mode } = getContext();

	let loading = $state(false);

	async function cleanUnreferenced() {
		if (loading) return;
		loading = true;
		const notice = showProgress(t("cleanUnreferenced"));
		try {
			let i = 0;
			for await (const { node } of casMetadata.find({
				filterBy: {
					hasReference: false,
				},
				signal: undefined,
			})) {
				await cas.trash(node.cid);
				i++;
				notice.update(i, node.cid.toString());
			}
		} finally {
			loading = false;
			notice.hide();
		}
	}

	async function rebuildIndex() {
		if (loading) return;
		loading = true;
		const notice = showProgress(t("rebuildIndex"));
		try {
			let i = 0;
			for await (const obj of cas.objects()) {
				await casMetadata.merge(obj);
				i++;
				notice.update(i, obj.cid.toString());
			}
			await referenceManager.clearCache();
		} finally {
			loading = false;
			notice.hide();
		}
	}

	async function emptyTrash() {
		if (loading) return;
		loading = true;
		const notice = showProgress(t("emptyTrash"));
		try {
			await emptyTrashCmd(cas, casMetadata, (i, cidStr) => {
				notice.update(i, cidStr);
			});
		} finally {
			loading = false;
			notice.hide();
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
	{#if mode.value === Mode.LOCAL}
		<button
			type="button"
			class="flex-none"
			disabled={loading}
			onclick={() => rebuildIndex().catch(showError)}
		>
			{t("rebuildIndex")}
		</button>
	{:else if mode.value === Mode.RECYCLE_BIN}
		<button
			type="button"
			class="flex-none"
			disabled={loading}
			onclick={() => emptyTrash().catch(showError)}
		>
			{t("emptyTrash")}
		</button>
	{:else if mode.value === Mode.UNREFERENCED}
		<button
			type="button"
			class="flex-none"
			disabled={loading}
			onclick={() => cleanUnreferenced().catch(showError)}
		>
			{t("cleanUnreferenced")}
		</button>
	{/if}
</div>

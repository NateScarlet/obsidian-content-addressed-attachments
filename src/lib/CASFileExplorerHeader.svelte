<script module lang="ts">
	import showError from "#src/utils/showError";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorerContext";

	const { t } = defineLocales({
		en: {
			searchPlaceholder: "Search files...",
			emptyTrash: "Empty trash",
			cleanUnreferenced: "Clean unreferenced files",
			cleanUnreferencedScan: "Checking references",
			cleanUnreferencedClean: "Moving to trash",
			rebuildIndex: "Rebuild index",
		},
		zh: {
			searchPlaceholder: "搜索文件...",
			emptyTrash: "清空回收站",
			cleanUnreferenced: "清理未引用文件",
			cleanUnreferencedScan: "检查引用状态",
			cleanUnreferencedClean: "移入回收站",
			rebuildIndex: "重建索引",
		},
	});
</script>

<script lang="ts">
	import showProgress from "#src/utils/showProgress";
	import emptyTrashCmd from "#src/commands/emptyTrash";
	import rebuildIndexCmd from "#src/commands/rebuildIndex";
	import cleanUnreferencedCmd from "#src/commands/cleanUnreferenced";

	const {
		cas,
		casMetadata,
		referenceManager,
		query,
		mode,
		metadataWriteSignal,
		getPrimaryDir,
		getDownloadDirs,
	} = getContext();

	let loading = $state(false);

	async function cleanUnreferenced() {
		if (loading) return;
		loading = true;
		// 引用判定（含 ensureFresh）在数据层 hasReference 筛选内完成；此进度条表达"检查引用状态"进行中
		const scanNotice = showProgress(t("cleanUnreferencedScan"));
		let cleanNotice: ReturnType<typeof showProgress> | undefined;
		try {
			await cleanUnreferencedCmd(
				cas,
				casMetadata,
				(i, cidStr) => {
					cleanNotice ??= showProgress(
						t("cleanUnreferencedClean"),
					);
					cleanNotice.update(i, cidStr);
				},
				{ signal: metadataWriteSignal },
			);
		} finally {
			scanNotice.hide();
			cleanNotice?.hide();
			loading = false;
		}
	}

	async function rebuildIndex() {
		if (loading) return;
		loading = true;
		const notice = showProgress(t("rebuildIndex"));
		try {
			await rebuildIndexCmd(
				cas,
				casMetadata,
				referenceManager,
				(i, cidStr) => notice.update(i, cidStr),
				{ signal: metadataWriteSignal },
			);
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
			await emptyTrashCmd(
				cas,
				casMetadata,
				{
					referenceManager,
					primaryDir: getPrimaryDir(),
					downloadDirs: getDownloadDirs(),
				},
				(i, cidStr) => {
					notice.update(i, cidStr);
				},
			);
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

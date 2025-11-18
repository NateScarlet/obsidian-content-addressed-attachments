<script lang="ts">
	import type { MigrationProgress } from "../MigrationManager";
	import defineLocales from "../utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			migrationProgress: "File Migration Progress",
			scanningFiles: "Scanning and migrating files, please wait...",
			migrationComplete: "✅ Migration Complete",
			migrationInfo: "ℹ️ Migration Complete",
			migratedFiles: (migrated: number) =>
				`Successfully migrated: ${migrated} files`,
			skippedFiles: (skipped: number) => `Skipped: ${skipped} files`,
			errorFiles: (errors: number) => `Errors: ${errors}`,
			processingFile: (current: number, total: number, file: string) =>
				`Processing file ${current}/${total}: ${file}`,
			viewDetails: "View Details",
			close: "Close",
			migrationFailed: "❌ Migration Failed",
			migrationCancelled: "⏹️ Migration Cancelled",
			cancel: "Cancel",
			cancelling: "Cancelling...",
			remainingFiles: (remaining: number) =>
				`${remaining} files remaining`,
			migrationCancelledByUser: "Migration cancelled by user",
		},
		zh: {
			migrationProgress: "文件迁移进度",
			scanningFiles: "正在扫描和迁移文件，请稍候...",
			migrationComplete: "✅ 迁移完成",
			migrationInfo: "ℹ️ 迁移完成",
			migratedFiles: (migrated: number) => `成功迁移: ${migrated} 个文件`,
			skippedFiles: (skipped: number) => `跳过: ${skipped} 个文件`,
			errorFiles: (errors: number) => `错误: ${errors} 个`,
			processingFile: (current: number, total: number, file: string) =>
				`正在处理文件 ${current}/${total}: ${file}`,
			viewDetails: "查看详细信息",
			close: "关闭",
			migrationFailed: "❌ 迁移失败",
			migrationCancelled: "⏹️ 迁移已取消",
			cancel: "取消",
			cancelling: "取消中...",
			remainingFiles: (remaining: number) => `剩余 ${remaining} 个文件`,
			migrationCancelledByUser: "迁移已被用户取消",
		},
	});
	//#endregion

	const progress: MigrationProgress = $state({
		migrated: 0,
		skipped: 0,
		errors: 0,
		details: [],
		status: "processing",
	});
	const error: string = $state("");
	const isCancelled: boolean = $state(false);

	let {
		ctr,
		onClose,
	}: {
		ctr: AbortController;
		onClose: () => void;
	} = $props();

	let isCancelling = $state(false);

	const progressText = $derived.by(() => {
		if (error) return t("migrationFailed");
		if (isCancelled) return t("migrationCancelled");
		if (progress.status === "completed") {
			return progress.migrated > 0
				? t("migrationComplete")
				: t("migrationInfo");
		}
		if (
			progress.currentFile &&
			progress.totalFiles &&
			progress.currentFileName
		) {
			return t("processingFile")(
				progress.currentFile,
				progress.totalFiles,
				progress.currentFileName,
			);
		}
		return t("scanningFiles");
	});

	const showCompletion = $derived(
		progress.status === "completed" || isCancelled || error,
	);
	const showCancelButton = $derived(!showCompletion && !isCancelling);

	const hasMeaningfulDetails = $derived.by(() => {
		return (
			progress.details.length > 0 &&
			progress.details.some(
				(d) => !d.includes("跳过笔记") && !d.includes("Skipped note"),
			)
		);
	});

	function handleCancel() {
		isCancelling = true;
		ctr.abort();
	}

	export { progress, isCancelled, error };
</script>

<div class="p-5 max-w-[600px] migration-progress-modal">
	<h2 class="text-xl font-semibold mb-4 mt-0 text-normal">
		{t("migrationProgress")}
	</h2>

	<div class="font-semibold mb-3 text-normal migration-progress-text">
		{progressText}
	</div>

	<div class="my-3 migration-stats">
		{#if progress.status === "completed" || progress.status === "processing"}
			<p class="my-1 text-normal">
				{t("migratedFiles")(progress.migrated)}
			</p>
			<p class="my-1 text-normal">
				{t("skippedFiles")(progress.skipped)}
			</p>

			{#if progress.errors > 0}
				<p class="my-1 text-error">
					{t("errorFiles")(progress.errors)}
				</p>
			{/if}

			{#if progress.totalFiles && progress.currentFile}
				<p class="my-1 text-muted">
					{t("remainingFiles")(
						progress.totalFiles - progress.currentFile,
					)}
				</p>
			{/if}
		{/if}

		{#if isCancelled}
			<p class="my-1 text-warning">{t("migrationCancelledByUser")}</p>
		{/if}

		{#if error}
			<p class="my-1 text-error">{error}</p>
		{/if}
	</div>

	{#if progress.status === "completed" && hasMeaningfulDetails}
		<details class="mt-3 migration-details">
			<summary
				class="cursor-pointer mb-1 text-accent hover:text-accent-hover"
			>
				{t("viewDetails")}
			</summary>
			<ul class="my-1 ml-5 list-disc">
				{#each progress.details as detail}
					<li class="break-all text-sm mb-0.5 text-normal">
						{detail}
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	<div class="flex gap-3 mt-4 modal-button-container">
		{#if showCancelButton}
			<button
				class="flex-1 px-4 py-2 bg-interactive-normal text-on-accent rounded-md hover:bg-interactive-hover transition-colors"
				onclick={handleCancel}
			>
				{t("cancel")}
			</button>
		{:else if isCancelling}
			<button
				class="flex-1 px-4 py-2 bg-form-field text-muted rounded-md cursor-not-allowed"
				disabled
			>
				{t("cancelling")}
			</button>
		{/if}

		{#if showCompletion}
			<button
				class="flex-1 px-4 py-2 bg-interactive-normal text-on-accent rounded-md hover:bg-interactive-hover transition-colors"
				onclick={onClose}
			>
				{t("close")}
			</button>
		{/if}
	</div>
</div>

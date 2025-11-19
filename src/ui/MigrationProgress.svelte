<script module lang="ts">
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
</script>

<script lang="ts">
	import clsx from "clsx";
	import type { MigrationProgress } from "../MigrationManager";

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

	const hasMeaningfulDetails = $derived.by(() => {
		return (
			progress.details.length > 0 &&
			progress.details.some(
				(d) => !d.includes("跳过笔记") && !d.includes("Skipped note"),
			)
		);
	});

	// 声明式统计信息配置 - 只在需要时生成元素
	const statsItems = $derived([
		// 处理中或完成时的统计信息
		...(progress.status === "completed" || progress.status === "processing"
			? [
					{
						text: t("migratedFiles")(progress.migrated),
						class: clsx`text-normal`,
					},
					{
						text: t("skippedFiles")(progress.skipped),
						class: clsx`text-normal`,
					},
					...(progress.errors > 0
						? [
								{
									text: t("errorFiles")(progress.errors),
									class: clsx`text-error`,
								},
							]
						: []),
					...(progress.totalFiles && progress.currentFile
						? [
								{
									text: t("remainingFiles")(
										progress.totalFiles -
											progress.currentFile,
									),
									class: clsx`text-muted`,
								},
							]
						: []),
				]
			: []),

		// 取消时的信息
		...(isCancelled
			? [
					{
						text: t("migrationCancelledByUser"),
						class: clsx`text-warning`,
					},
				]
			: []),

		// 错误信息
		...(error ? [{ text: error, class: clsx`text-error` }] : []),
	]);

	const buttonAttrs = $derived.by(() => {
		if (progress.status === "completed") {
			return {
				text: t("close"),
				onClick: onClose,
				class: clsx`bg-interactive-normal text-on-accent hover:bg-interactive-hover`,
				disabled: false,
			};
		}
		if (isCancelling) {
			return {
				text: t("cancelling"),
				onClick: null,
				class: clsx`bg-form-field text-muted cursor-not-allowed`,
				disabled: true,
			};
		}
		return {
			text: t("cancel"),
			onClick: () => {
				isCancelling = true;
				ctr.abort();
			},
			class: clsx`bg-interactive-normal text-on-accent hover:bg-interactive-hover`,
			disabled: false,
		};
	});

	export { progress, isCancelled, error };
</script>

<div class="p-5 max-w-[600px] migration-progress-modal">
	<h2 class="text-xl font-semibold mb-4 mt-0 text-normal">
		{t("migrationProgress")}
	</h2>

	<div class="font-semibold mb-3 text-normal migration-progress-text">
		{progressText}
	</div>

	<!-- 动态统计信息 -->
	<div class="my-3 migration-stats">
		{#each statsItems as item}
			<p class="my-1 {item.class}">{item.text}</p>
		{/each}
	</div>

	<!-- 动态详情区域 -->
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

	<!-- 按钮 -->
	<div class="flex gap-3 mt-4 modal-button-container">
		<button
			class="flex-1 px-4 py-2 rounded-md transition-colors {buttonAttrs.class}"
			onclick={buttonAttrs.onClick}
			disabled={buttonAttrs.disabled}
		>
			{buttonAttrs.text}
		</button>
	</div>
</div>

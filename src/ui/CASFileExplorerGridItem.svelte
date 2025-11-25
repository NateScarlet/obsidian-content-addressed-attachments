<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			moveToTrash: "Move to Trash",
			restore: "Restore",
			permanentlyDelete: "Permanently Delete",
			filename: "Filename",
			format: "Format",
			size: "Size",
			indexedAt: "Indexed",
			references: "References",
			trashedAt: "Trashed",
		},
		zh: {
			filename: "文件名",
			format: "格式",
			size: "大小",
			indexedAt: "索引时间",
			references: "引用",
			moveToTrash: "移至回收站",
			restore: "还原",
			permanentlyDelete: "永久删除",
			trashedAt: "删除时间",
		},
	});

	function formatDate(date: Date) {
		return date.toLocaleDateString() + " " + date.toLocaleTimeString();
	}
</script>

<script lang="ts">
	import { getContext, type FileItem } from "./CASFileExplorer.svelte";

	const { cas, app, trashFile, deleteFile, goToReference } = getContext();

	let {
		file,
	}: {
		file: FileItem;
	} = $props();

	let imgSrc = $state("");
	$effect(() => {
		if (file.trashedAt) {
			return;
		}
		const path = cas.formatNormalizePath(file.cid);
		const src = app.vault.adapter.getResourcePath(path);
		if (file.format.startsWith("image/")) {
			imgSrc = src;
			return;
		}
		if (file.format) {
			// 已知不是图片
			return;
		}
		// 尝试加载未知格式为图片
		const img = new Image();
		img.src = src;
		img.decode()
			.then(() => {
				imgSrc = src;
			})
			.catch(() => undefined);
		return () => {
			img.src = "";
			imgSrc = "";
		};
	});
</script>

<!-- 卡片布局 -->
<div
	class="border border-border rounded-lg p-4 bg-secondary hover:bg-hover transition-colors"
>
	<!-- 图片预览 -->
	{#if imgSrc}
		<div class="mb-3 flex justify-center">
			<img
				src={imgSrc}
				class="max-h-32 max-w-full rounded"
				alt={file.filename}
				title="{file.filename} ({file.cid})"
			/>
		</div>
	{/if}

	<!-- 文件信息 -->
	<div class="space-y-2">
		<!-- 文件名 -->
		<div
			class={[
				"font-semibold text-normal truncate",
				file.trashedAt ? "line-through" : "",
			]}
			title={file.filename}
		>
			{file.filename}
		</div>

		<!-- 元数据 -->
		<div class="text-sm text-muted space-y-1">
			<div class="flex justify-between">
				<span>{t("format")}:</span>
				<span>{file.format || (imgSrc ? "image/*" : "unknown")}</span>
			</div>
			<div class="flex justify-between">
				<span>{t("size")}:</span>
				<span title="{file.size} Byte">{formatFileSize(file.size)}</span
				>
			</div>
			<div class="flex justify-between">
				<span>{t("indexedAt")}:</span>
				<span>{formatDate(file.indexedAt)}</span>
			</div>
			{#if file.trashedAt}
				<div class="flex justify-between">
					<span>{t("trashedAt")}:</span>
					<span>{formatDate(file.trashedAt)}</span>
				</div>
			{/if}
			<div class="flex justify-between">
				<span>{t("references")}:</span>
				<span
					class={[
						file.references &&
							"underline text-interactive-accent cursor-pointer",
					]}
					onclick={() => goToReference(file.cid)}
				>
					{file.references}
				</span>
			</div>
		</div>

		<!-- 操作按钮 -->
		<div class="flex gap-2 pt-2">
			{#if !file.trashedAt}
				<button
					class="flex-1 px-2 py-1 bg-warning text-on-accent rounded text-xs hover:bg-warning/80"
					onclick={() => trashFile(file.cid)}
				>
					{t("moveToTrash")}
				</button>
			{:else}
				<button
					class="flex-1 px-2 py-1 bg-warning text-on-accent rounded text-xs hover:bg-warning/80"
					onclick={() => cas.load(file.cid)}
				>
					{t("restore")}
				</button>
				<button
					class="flex-1 px-2 py-1 bg-error text-on-accent rounded text-xs hover:bg-error/80"
					onclick={() => deleteFile(file.cid, file.filename)}
				>
					{t("permanentlyDelete")}
				</button>
			{/if}
		</div>
	</div>
</div>

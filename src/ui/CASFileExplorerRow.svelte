<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			moveToTrash: "Move to Trash",
			restore: "Restore",
			permanentlyDelete: "Permanently Delete",
		},
		zh: {
			moveToTrash: "移至回收站",
			restore: "还原",
			permanentlyDelete: "永久删除",
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

<tr class="border-b border-border hover:bg-hover">
	<td class="p-3 text-normal">
		{#if imgSrc}
			<img
				src={imgSrc}
				class="max-h-24"
				alt={file.filename}
				title="{file.filename} ({file.cid})"
			/>
		{:else}
			{file.filename}
		{/if}
	</td>
	<td class="p-3 text-muted"
		>{file.format || imgSrc ? "image/*" : "unknown"}</td
	>
	<td class="p-3 text-muted" title="{file.size} Byte"
		>{formatFileSize(file.size)}</td
	>
	<td class="p-3 text-muted">{formatDate(file.indexedAt)}</td>
	<td
		class={[
			"p-3 text-muted",
			file.references &&
				"underline text-interactive-normal cursor-pointer",
		]}
		onclick={() => goToReference(file.cid)}
	>
		{file.references}
	</td>
	<td class="p-3">
		<div class="flex gap-2">
			{#if !file.trashedAt}
				<button
					class="px-2 py-1 bg-warning text-on-accent rounded text-xs hover:bg-warning/80"
					onclick={() => trashFile(file.cid)}
				>
					{t("moveToTrash")}
				</button>
			{:else}
				<button
					class="px-2 py-1 bg-warning text-on-accent rounded text-xs hover:bg-warning/80"
					onclick={() => cas.load(file.cid)}
				>
					{t("restore")}
				</button>
				<button
					class="px-2 py-1 bg-error text-on-accent rounded text-xs hover:bg-error/80"
					onclick={() => deleteFile(file.cid, file.filename)}
				>
					{t("permanentlyDelete")}
				</button>
			{/if}
		</div>
	</td>
</tr>

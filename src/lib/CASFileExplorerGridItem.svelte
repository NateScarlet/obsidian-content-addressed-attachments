<script lang="ts">
	import { getContext } from "./CASFileExplorerContext";
	import type { CASMetadataObject } from "#src/types/CASMetadata";
	import { MarkdownView, Notice } from "obsidian";
	import showError from "#src/utils/showError";
	import formatFileSize from "#src/utils/formatFileSize";
	import { ENCRYPTED_FORMAT } from "./encryption/constants";

	let { file }: { file: CASMetadataObject } = $props();

	const { cas, casMetadata, app, encryptionService } = getContext();

	let isTrashing = $state(false);

	let format = $derived(file.format);
	let filename = $derived(file.filename);

	let imgSrcPromise = $derived.by(async (): Promise<string | undefined> => {
		if (format && !format.startsWith("image/") && format !== ENCRYPTED_FORMAT) {
			return undefined;
		}

		const match = await cas.load(file.cid);
		if (!match) return undefined;

		const buffer = await app.vault.adapter.readBinary(match.normalizedPath);
		const decrypted = await encryptionService.ensureDecrypted(buffer);

		if (decrypted.mimeType.startsWith("image/")) {
			return decrypted.toBlobURL();
		}

		return undefined;
	});

	function insertLink(embed: boolean) {
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("No active Markdown view");
			return;
		}
		const editor = view.editor;

		const linkText = `ipfs://${file.cid.toString()}?filename=${encodeURIComponent(
			filename ?? "",
		)}&format=${encodeURIComponent(format ?? "")}`;

		const isImage = format?.startsWith("image/") || format === ENCRYPTED_FORMAT;
		const markdownLink =
			embed || isImage ? `![${filename}](${linkText})` : `[${filename}](${linkText})`;

		editor.replaceSelection(markdownLink);
	}

	async function handleTrash() {
		isTrashing = true;
		try {
			await cas.trash(file.cid);
			await casMetadata.delete(file.cid);
		} catch (err) {
			showError(err);
		} finally {
			isTrashing = false;
		}
	}
</script>

<div
	class="group relative flex flex-col rounded-lg border border-theme-border bg-theme-bg p-2 transition-all hover:border-theme-border-hover hover:shadow-sm"
	role="region"
	aria-label={filename ?? file.cid.toString()}
>
	<!-- 预览区域 -->
	<div
		class="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-theme-bg-secondary"
	>
		{#await imgSrcPromise}
			<div class="animate-pulse text-xs text-theme-text-muted">Loading...</div>
		{:then src}
			{#if src}
				<img
					{src}
					alt={filename ?? file.cid.toString()}
					class="h-full w-full object-cover"
				/>
			{:else}
				<div class="flex flex-col items-center justify-center p-2 text-center">
					<span class="text-xs font-medium text-theme-text-muted truncate max-w-full">
						{format ?? "Unknown"}
					</span>
				</div>
			{/if}
		{:catch err}
			<div class="text-xs text-theme-error p-1 text-center truncate max-w-full" title={err instanceof Error ? err.message : String(err)}>
				{err instanceof Error ? err.message : String(err)}
			</div>
		{/await}
	</div>

	<!-- 文件信息区域 -->
	<div class="mt-2 flex flex-col gap-0.5">
		<span
			class="truncate text-xs font-medium text-theme-text"
			title={filename ?? file.cid.toString()}
		>
			{filename ?? file.cid.toString()}
		</span>
		<div class="flex items-center justify-between text-[10px] text-theme-text-muted">
			<span>{formatFileSize(file.size ?? 0)}</span>
		</div>
	</div>

	<!-- 悬浮操作面板 -->
	<div
		class="absolute inset-0 hidden items-center justify-center gap-2 rounded-lg bg-black/40 backdrop-blur-[1px] group-hover:flex"
	>
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-800 shadow hover:bg-gray-100 text-xs font-bold"
			title="Insert Link"
			onclick={() => insertLink(false)}
		>
			Link
		</button>
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-white shadow hover:bg-red-700 disabled:opacity-50 text-xs font-bold"
			title="Trash"
			disabled={isTrashing}
			onclick={handleTrash}
		>
			Trash
		</button>
	</div>
</div>

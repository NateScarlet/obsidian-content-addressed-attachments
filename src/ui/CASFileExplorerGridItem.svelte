<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";

	const { t } = defineLocales({
		en: {
			moveToTrash: "Move to Trash",
			restore: "Restore",
			permanentlyDelete: "Permanently Delete",
			indexedAt: "Indexed at",
			trashedAt: "Trashed at",
			fetchMore: "Fetch more",
		},
		zh: {
			indexedAt: "索引于",
			moveToTrash: "移动至回收站",
			restore: "还原",
			permanentlyDelete: "永久删除",
			trashedAt: "删除于",
			fetchMore: "加载更多",
		},
	});

	function formatDate(date: Date) {
		return date.toLocaleDateString() + " " + date.toLocaleTimeString();
	}
</script>

<script lang="ts">
	import { getContext, type FileItem } from "./CASFileExplorer.svelte";
	import { MarkdownView } from "obsidian";
	import type { CID } from "multiformats/dist/src";
	import showError from "src/utils/showError";
	import { getAbortSignal } from "svelte";

	const { cas, app, referenceManager, trashFile, deleteFile } = getContext();

	let {
		file,
	}: {
		file: FileItem;
	} = $props();

	async function load(signal: AbortSignal) {
		const match = await cas.lookup(file.cid);
		if (!match) {
			return { ok: false };
		}
		signal.throwIfAborted();
		const imgSrc = await (async () => {
			const { format } = file;
			if (format && !format.startsWith("image/")) {
				// 已知不是图片
				return;
			}
			const { path } = match;
			const src = app.vault.adapter.getResourcePath(path);
			if (format) {
				return src;
			}
			// 尝试加载未知格式为图片
			const img = new Image();
			img.src = src;
			return img
				.decode()
				.then(() => {
					return src;
				})
				.catch(() => undefined);
		})();
		signal.throwIfAborted();
		return {
			ok: true,
			match,
			imgSrc,
			format: file.format || (imgSrc ? "image/*" : ""),
		};
	}

	let detail = $state<Awaited<ReturnType<typeof load>>>();

	$effect(() => {
		void file.cid;
		const signal = getAbortSignal();
		load(signal)
			.then((v) => {
				detail = v;
			})
			.catch(showError);
		return () => {
			detail = undefined;
		};
	});

	const format = $derived(detail?.format || file.format || "*/*");
	const isDeleted = $derived(!!file.trashedAt || detail?.ok === false);

	let limit = $state(20);
	function fetchMore() {
		limit += 20;
	}

	const references = $derived(
		(async (cid: CID, limit: number, signal: AbortSignal) => {
			return Array.fromAsync(
				(async function* () {
					let count = 0;
					for await (const {
						file,
						url,
						title,
						pos,
					} of referenceManager.findReference(cid)) {
						if (signal.aborted) {
							return;
						}
						yield {
							file,
							name: url.filename || title,
							anchorAttrs: {
								onclick: async () => {
									try {
										const leaf =
											app.workspace.getLeaf(false);
										await leaf.openFile(file);
										const view = leaf.view;
										if (view instanceof MarkdownView) {
											const editor = view.editor;
											const range = {
												from: editor.offsetToPos(
													pos[0],
												),
												to: editor.offsetToPos(pos[1]),
											};
											editor.setSelection(
												range.from,
												range.to,
											);
											editor.scrollIntoView(range, true);
										}
									} catch (err) {
										showError(err);
									}
								},
							},
						};
						count += 1;
						if (count == limit) {
							return;
						}
					}
				})(),
			);
		})(file.cid, limit, getAbortSignal()),
	);
</script>

<!-- 卡片布局 -->
<div
	class="border rounded-lg p-1 @sm:p-2 @md:p-4 bg-secondary hover:bg-hover transition duration-300 ease-in-out"
>
	<!-- 图片预览 -->
	{#if detail?.imgSrc}
		<div class="mb-3 flex justify-center">
			<img
				src={detail.imgSrc}
				class="max-h-32 max-w-full rounded"
				alt={file.filename}
				loading="lazy"
				title="{file.filename} ({file.cid})"
			/>
		</div>
	{/if}

	<!-- 文件名 -->
	<div
		class={[
			"font-semibold truncate text-center",
			{
				"text-muted": file.trashedAt,
				"text-error": !file.trashedAt && isDeleted,
				"text-normal": !isDeleted,
				"line-through": isDeleted,
			},
		]}
		title={file.filename}
	>
		{file.filename}
	</div>
	<!-- 元数据 -->
	<div class="text-center space-x-1 text-sm text-muted">
		<span>{format}</span>
		<span title="{file.size} Byte">{formatFileSize(file.size)}</span>
	</div>

	<!-- 引用文件列表 -->
	<ul class="space-y-1 max-h-64 overflow-y-auto">
		{#await references}
			{#each Array.from({ length: 5 }) as i (i)}
				<li class="bg-secondary-alt/75 animate-pulse">
					<wbr />
				</li>
			{/each}
		{:then items}
			{#each items as i (i.file.path)}
				<li>
					<a {...i.anchorAttrs}>
						{i.file.path}
					</a>
					{#if i.name && i.name !== file.filename}
						<span>|</span>
						<span>{i.name}</span>
					{/if}
				</li>
			{/each}
			{#if items.length == limit}
				<button type="button" class="w-full" onclick={fetchMore}>
					{t("fetchMore")}
				</button>
			{/if}
		{/await}
	</ul>

	<!-- 操作按钮 -->
	<div class="flex gap-2">
		{#if !isDeleted}
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

	<!-- 时间戳 -->
	<div class="text-xs text-muted text-right m-1">
		{#if file.trashedAt}
			<span class="flex-none">
				<span>{t("trashedAt")}:</span>
				<time datetime={file.trashedAt.toISOString()}
					>{formatDate(file.trashedAt)}</time
				>
			</span>
		{:else}
			<span class="flex-none">
				<span>{t("indexedAt")}</span>
				<time datetime={file.indexedAt.toISOString()}
					>{formatDate(file.indexedAt)}</time
				>
			</span>
		{/if}
	</div>
</div>

<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import type { Action } from "svelte/action";

	const { t } = defineLocales({
		en: {
			restore: "Restore",
			indexedAt: "Indexed at",
			trashedAt: "Trashed at",
			fetchMore: "Fetch More",
			canNotRestoreFromExternal: "Can not restore from external storage",
			copied: "Copied markdown link to clipboard",
			copyLink: "Copy Link",
		},
		zh: {
			indexedAt: "索引于",
			restore: "还原",
			trashedAt: "删除于",
			fetchMore: "加载更多",
			canNotRestoreFromExternal: "无法从外部存储还原",
			copied: "已复制 Markdown 链接到剪贴板",
			copyLink: "复制链接",
		},
	});

	function formatDate(date: Date) {
		return date.toLocaleDateString() + " " + date.toLocaleTimeString();
	}

	function generateMarkdownLink(file: FileItem, format: string): string {
		const url = new URL(`ipfs://${file.cid.toString()}`);
		if (file.filename) {
			url.searchParams.set("filename", file.filename);
		}
		if (format && !format.includes("*")) {
			url.searchParams.set("format", format);
		}
		if (format.startsWith("image/")) {
			return `![${file.filename || "image"}](${url})`;
		} else {
			return `[${file.filename ?? "attachment"}](${url})`;
		}
	}
</script>

<script lang="ts">
	import { getContext, type FileItem } from "./CASFileExplorer.svelte";
	import { MarkdownView, Notice } from "obsidian";
	import showError from "src/utils/showError";
	import { getAbortSignal } from "svelte";
	import {
		mdiDeleteAlertOutline,
		mdiLinkVariant,
		mdiRestore,
		mdiTrashCanOutline,
	} from "@mdi/js";
	import { markdownChange, referenceChange } from "src/events";
	import { writable } from "svelte/store";
	import staleWithRevalidate from "src/utils/staleWhileRevalidate";

	const { cas, app, referenceManager, trashFile, deleteFile } = getContext();

	let {
		file,
	}: {
		file: FileItem;
	} = $props();

	async function restoreFile() {
		const result = await cas.load(file.cid);
		if (!result) {
			new Notice(t("canNotRestoreFromExternal"));
		}
	}

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
	let version = $state(0);
	$effect(() => {
		return referenceChange.subscribe((e) => {
			if (e.detail.cid.equals(file.cid)) {
				version += 1;
			}
		});
	});
	$effect(() => {
		return markdownChange.subscribe(async (e) => {
			if ($references?.some((i) => i.file.path === e.detail.path)) {
				version += 1;
			}
		});
	});

	const { result: references, revalidate: revalidateReferences } =
		staleWithRevalidate(async () => {
			const cid = file.cid;
			const signal = getAbortSignal();
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
							name: title || url.filename,
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
		});
	$effect(() => {
		void version;
		void limit;
		void file.cid;
		revalidateReferences();
	});

	const drag: Action<HTMLElement> = (node) => {
		node.draggable = true;
		const handleDragStart = (event: DragEvent) => {
			const markdownLink = generateMarkdownLink(file, format);
			event.dataTransfer?.setData("text/plain", markdownLink);
		};

		node.addEventListener("dragstart", handleDragStart);
		return {
			destroy() {
				node.removeEventListener("dragstart", handleDragStart);
			},
		};
	};

	async function copyLink() {
		const markdownLink = generateMarkdownLink(file, format);
		await navigator.clipboard.writeText(markdownLink);
		new Notice(t("copied"));
	}
</script>

<!-- 卡片布局 -->
<div
	use:drag
	class="flex flex-col border rounded-lg p-1 @md:p-2 bg-secondary hover:bg-hover transition duration-300 ease-in-out"
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
				"text-muted": file.trashedAt && detail?.ok,
				"text-error": detail?.ok === false,
				"text-normal": !isDeleted,
				"line-through": file.trashedAt,
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
	<ul class="space-y-1 max-h-64 overflow-y-auto list-none m-1 p-0">
		{#each $references as i (i.file.path)}
			<li class="break-all">
				<a {...i.anchorAttrs}>
					{i.file.path}
				</a>
				{#if i.name && i.name !== file.filename}
					<span>|</span>
					<span>{i.name}</span>
				{/if}
			</li>
		{/each}
		{#if $references?.length == limit}
			<button type="button" class="w-full" onclick={fetchMore}>
				{t("fetchMore")}
			</button>
		{/if}
	</ul>

	<div class="flex-auto"></div>

	<!-- 操作按钮 -->
	<div class="flex gap-2">
		{#if !isDeleted}
			<!-- 复制 -->
			<button class="flex-2" onclick={() => copyLink().catch(showError)}>
				<svg
					class="inline fill-current h-[1.25rem]"
					viewBox="0 0 24 24"
				>
					<path d={mdiLinkVariant} />
				</svg>
				<span>{t("copyLink")}</span>
			</button>
			<!-- 移动到回收站 -->
			<button
				class="flex-1"
				onclick={() => trashFile(file.cid).catch(showError)}
			>
				<svg
					class="inline fill-current h-[1.25rem]"
					viewBox="0 0 24 24"
				>
					<path d={mdiTrashCanOutline} />
				</svg>
				<wbr />
			</button>
		{:else}
			<button
				class="flex-2"
				onclick={() => restoreFile().catch(showError)}
			>
				<svg
					class="inline fill-current h-[1.25rem]"
					viewBox="0 0 24 24"
				>
					<path d={mdiRestore} />
				</svg>
				{t("restore")}
			</button>
			<button
				class="flex-1 bg-error! text-primary!"
				onclick={() =>
					deleteFile(file.cid, file.filename).catch(showError)}
			>
				<svg
					class="inline fill-current h-[1.25rem]"
					viewBox="0 0 24 24"
				>
					<path d={mdiDeleteAlertOutline} />
				</svg>
				<wbr />
			</button>
		{/if}
	</div>

	<div class="flex flex-wrap justify-between text-faint text-xs gap-1">
		<span class="select-all truncate flex-1 font-mono">{file.cid}</span>
		<!-- 时间戳 -->
		<div class="flex-none text-right">
			{#if file.trashedAt}
				<span class="flex-none">
					<span>{t("trashedAt")}</span>
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
</div>

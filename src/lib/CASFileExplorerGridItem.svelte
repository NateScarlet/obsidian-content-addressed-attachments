<script module lang="ts">
	import formatFileSize from "#src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import type { CASMetadataObject } from "#src/types/CASMetadata";
	import { ENCRYPTED_FORMAT } from "./encryption/constants";

	const { t } = defineLocales({
		en: {
			confirmPermanentDelete: (filename: string) =>
				`Permanently delete "${filename}"? This action cannot be undone.`,
			restore: "Restore",
			indexedAt: "Indexed at",
			trashedAt: "Trashed at",
			fetchMore: "Fetch more",
			canNotRestoreFromGateway: "Can not restore from gateway",
			copied: "Copied markdown link to clipboard",
			copyLink: "Copy link",
		},
		zh: {
			confirmPermanentDelete: (filename: string) =>
				`永久删除"${filename}"？此操作无法撤销。`,
			indexedAt: "索引于",
			restore: "还原",
			trashedAt: "删除于",
			fetchMore: "加载更多",
			canNotRestoreFromGateway: "无法从网关还原",
			copied: "已复制 Markdown 链接到剪贴板",
			copyLink: "复制链接",
		},
	});

	function formatDate(date: Date) {
		return date.toLocaleDateString() + " " + date.toLocaleTimeString();
	}

	function generateMarkdownLink(
		file: CASMetadataObject,
		format: string,
		isEncrypted?: boolean,
	): string {
		const url = new URL(`ipfs://${file.cid.toString()}`);
		if (file.filename) {
			url.searchParams.set("filename", file.filename);
		}
		const linkFormat = isEncrypted ? ENCRYPTED_FORMAT : format;
		if (linkFormat && !linkFormat.includes("*")) {
			url.searchParams.set("format", linkFormat);
		}
		if (format.startsWith("image/")) {
			return `![${file.filename || "image"}](${url})`;
		} else {
			return `[${file.filename ?? "attachment"}](${url})`;
		}
	}
</script>

<script lang="ts">
	import { getContext } from "./CASFileExplorerContext";
	import { isEncryptedData, parseHeader } from "./encryption/fileHeader";
	import { MarkdownView, Notice } from "obsidian";
	import showError from "#src/utils/showError";
	import { getAbortSignal } from "svelte";
	import {
		mdiDeleteAlertOutline,
		mdiLinkVariant,
		mdiLock,
		mdiRestore,
		mdiTrashCanOutline,
	} from "@mdi/js";
	import { referenceChange } from "#src/events";
	import staleWithRevalidate from "#src/lib/stores/staleWhileRevalidate.svelte";
	import type { Attachment } from "svelte/attachments";

	const { cas, app, referenceManager, encryptionService } = getContext();

	let {
		file,
	}: {
		file: CASMetadataObject;
	} = $props();

	async function restoreFile() {
		const result = await cas.load(file.cid);
		if (!result) {
			new Notice(t("canNotRestoreFromGateway"));
		}
	}

	async function deleteFile() {
		if (
			!confirm(
				t("confirmPermanentDelete")(
					$detail?.filename || file.filename || file.cid.toString(),
				),
			)
		) {
			return;
		}
		await cas.deleteIfTrashed(file.cid);
	}

	const { result: detail } = staleWithRevalidate(async () => {
		const signal = getAbortSignal();
		console.debug("load", file.cid.toString());
		for await (const match of cas.lookup(file.cid)) {
			signal.throwIfAborted();

			let filename = file.filename ?? "";
			let format = file.format ?? "";

			// 基于实际引用获取缺少的文件名和格式
			if (!filename || !format) {
				for await (const {
					url,
					title,
				} of referenceManager.findReference(file.cid, signal)) {
					filename = filename || url.filename || title || "";
					format = format || url.format || "";
					if (filename && format) {
						break;
					}
				}
			}

			let isEncrypted = format === ENCRYPTED_FORMAT;
			let fileBuffer: ArrayBuffer | undefined;

			try {
				fileBuffer = await app.vault.adapter.readBinary(match.path);
				if (fileBuffer && isEncryptedData(fileBuffer)) {
					isEncrypted = true;
					try {
						const header = parseHeader(fileBuffer);
						format = header.originalFormat;
					} catch {
						// ignore parse header error
					}
				}
			} catch {
				// ignore read error
			}

			const imgSrc = await (async () => {
				if (
					format &&
					!format.startsWith("image/") &&
					format !== "image/*"
				) {
					return undefined;
				}

				if (isEncrypted && fileBuffer) {
					try {
						const decrypted = await encryptionService.ensureDecrypted(fileBuffer);
						if (decrypted && decrypted.mimeType.startsWith("image/")) {
							return decrypted.toBlobURL();
						}
					} catch (err) {
						console.debug("Failed to decrypt image preview for CAS item:", err);
					}
					return undefined;
				}

				const src = app.vault.adapter.getResourcePath(match.path);
				if (format) {
					return src;
				}

				return app.vault.adapter
					.readBinary(match.path)
					.then((data) => {
						const blob = new Blob([data]);
						return URL.createObjectURL(blob);
					})
					.catch(() => undefined);
			})();

			signal.throwIfAborted();
			return {
				ok: true,
				match,
				imgSrc,
				format,
				filename,
				isEncrypted,
			};
		}
		return { ok: false };
	});

	const format = $derived($detail?.format || file.format || "*/*");
	const isEncrypted = $derived(
		$detail?.isEncrypted ?? file.format === ENCRYPTED_FORMAT,
	);
	const isDeleted = $derived(!!file.trashedAt || $detail?.ok === false);

	let limit = $state(20);

	function fetchMore() {
		limit += 20;
	}

	let version = $state(0);

	const { result: references } = staleWithRevalidate(async () => {
		void version;
		const signal = getAbortSignal();
		const cid = file.cid;
		return Array.fromAsync(
			(async function* () {
				let count = 0;
				for await (const {
					file,
					url,
					title,
					pos,
				} of referenceManager.findReference(cid, signal)) {
					if (signal.aborted) {
						return;
					}
					yield {
						file,
						name: title || url.filename,
						anchorAttrs: {
							onclick: async () => {
								try {
									const leaf = app.workspace.getLeaf(false);
									await leaf.openFile(file);
									const view = leaf.view;
									if (view instanceof MarkdownView) {
										const editor = view.editor;
										const range = {
											from: editor.offsetToPos(pos[0]),
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
		return referenceChange.subscribe((e) => {
			if (e.detail.cid.equals(file.cid)) {
				version += 1;
			}
		});
	});

	const drag: Attachment<HTMLElement> = (node) => {
		node.draggable = true;
		const handleDragStart = (event: DragEvent) => {
			const markdownLink = generateMarkdownLink(
				file,
				format,
				isEncrypted,
			);
			event.dataTransfer?.setData("text/plain", markdownLink);
		};

		node.addEventListener("dragstart", handleDragStart);
		return () => {
			node.removeEventListener("dragstart", handleDragStart);
		};
	};

	async function copyLink() {
		const markdownLink = generateMarkdownLink(file, format, isEncrypted);
		await navigator.clipboard.writeText(markdownLink);
		new Notice(t("copied"));
	}
</script>

<!-- 卡片布局 -->
<div
	{@attach drag}
	class="flex flex-col border rounded-lg p-1 @md:p-2 bg-secondary hover:bg-hover transition duration-300 ease-in-out"
>
	<!-- 图片预览 -->
	{#if $detail?.imgSrc}
		<div class="mb-3 flex justify-center">
			<img
				src={$detail.imgSrc}
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
			"font-semibold truncate text-center flex items-center justify-center gap-1",
			{
				"text-muted": file.trashedAt && $detail?.ok,
				"text-error": $detail?.ok === false,
				"text-normal": !isDeleted,
				"line-through": file.trashedAt,
			},
		]}
		title={file.filename}
	>
		{#if isEncrypted}
			<svg
				class="inline fill-current h-[1.1em] text-accent shrink-0"
				viewBox="0 0 24 24"
			>
				<path d={mdiLock} />
			</svg>
		{/if}
		<span class="truncate">{file.filename}</span>
	</div>
	<!-- 元数据 -->
	<div class="text-center space-x-1 text-sm text-muted">
		<span>{format}</span>
		<span title="{file.size} Byte"
			>{formatFileSize(
				$detail?.match?.stat.size ?? file.size ?? -1,
			)}</span
		>
	</div>

	<!-- 引用文件列表 -->
	<ul class="space-y-1 max-h-64 overflow-y-auto list-none m-1 p-0">
		{#if $references}
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
			{#if $references.length == limit}
				<button type="button" class="w-full" onclick={fetchMore}>
					{t("fetchMore")}
				</button>
			{/if}
		{/if}
	</ul>

	<div class="flex-auto"></div>

	<!-- 操作按钮 -->
	<div class="flex gap-2">
		{#if !isDeleted}
			<!-- 复制 -->
			<button class="flex-2" onclick={() => copyLink().catch(showError)}>
				<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
					<path d={mdiLinkVariant} />
				</svg>
				<span>{t("copyLink")}</span>
			</button>
			<!-- 移动到回收站 -->
			<button
				class="flex-1"
				onclick={() => cas.trash(file.cid).catch(showError)}
			>
				<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
					<path d={mdiTrashCanOutline} />
				</svg>
				<wbr />
			</button>
		{:else}
			<button
				class="flex-2"
				onclick={() => restoreFile().catch(showError)}
			>
				<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
					<path d={mdiRestore} />
				</svg>
				{t("restore")}
			</button>
			<button
				class="flex-1 bg-error! text-primary!"
				onclick={() => deleteFile().catch(showError)}
			>
				<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
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

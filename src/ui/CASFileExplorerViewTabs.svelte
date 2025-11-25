<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";

	const { t } = defineLocales({
		en: {
			allFiles: "All Files",
			unreferencedFiles: "Unreferenced Files",
			trashedFiles: "Trashed Files",
			fileViews: "File Views",
		},
		zh: {
			allFiles: "所有文件",
			unreferencedFiles: "未引用文件",
			trashedFiles: "回收站文件",
			fileViews: "文件视图",
		},
	});
</script>

<script lang="ts">
	const { casMetadata, mode, lastActivityAt } = getContext();
	let estimateStorage = $state(casMetadata.estimateStorage());
	$effect(() => {
		lastActivityAt.value;
		estimateStorage = casMetadata.estimateStorage();
	});
	const views = [Mode.ALL, Mode.UNREFERENCED, Mode.TRASHED];
	function handleKeydown(event: KeyboardEvent, view: Mode) {
		const currentIndex = views.indexOf(mode.value);

		switch (event.key) {
			case "Enter":
			case " ":
				event.preventDefault();
				mode.value = view;
				break;
			case "ArrowLeft":
			case "ArrowUp": {
				event.preventDefault();
				const prevIndex =
					(currentIndex - 1 + views.length) % views.length;
				mode.value = views[prevIndex];
				break;
			}
			case "ArrowRight":
			case "ArrowDown": {
				event.preventDefault();
				const nextIndex = (currentIndex + 1) % views.length;
				mode.value = views[nextIndex];
				break;
			}
			case "Home":
				event.preventDefault();
				mode.value = views[0];
				break;
			case "End":
				event.preventDefault();
				mode.value = views[views.length - 1];
				break;
		}
	}
	const totalBytes = $derived.by(async () => {
		const { normalBytes, trashBytes } = await estimateStorage;
		return normalBytes + trashBytes;
	});
	const trashBytes = $derived.by(async () => {
		const { trashBytes } = await estimateStorage;
		return trashBytes;
	});
	// 定义标签配置，只包含每个标签特有的属性
	const tabs = [
		{
			mode: Mode.ALL,
			translationKey: "allFiles" as const,
			size: () => totalBytes,
			attrs: {
				"aria-controls": "all-files-panel",
				id: "all-files-tab",
			},
		},
		{
			mode: Mode.UNREFERENCED,
			translationKey: "unreferencedFiles" as const,
			attrs: {
				"aria-controls": "unreferenced-files-panel",
				id: "unreferenced-files-tab",
			},
		},
		{
			mode: Mode.TRASHED,
			size: () => trashBytes,
			translationKey: "trashedFiles" as const,
			attrs: {
				"aria-controls": "trashed-files-panel",
				id: "trashed-files-tab",
			},
		},
	];
</script>

<div
	role="tablist"
	aria-label={t("fileViews")}
	class="flex border-b border-border"
>
	{#each tabs as tab, index (tab.mode)}
		<div
			{...tab.attrs}
			role="tab"
			tabindex={mode.value === tab.mode ? 0 : -1}
			aria-selected={mode.value === tab.mode}
			class={[
				"flex-1 px-4 py-2 text-sm  cursor-pointer select-none transition duration-300",
				mode.value === tab.mode
					? "text-on-accent bg-interactive-accent font-semibold hover:bg-interactive-accent-hover"
					: "text-normal bg-interactive-normal hover:bg-interactive-hover ",
				index === 0 && "rounded-l-sm",
				index === tabs.length - 1 && "rounded-r-sm",
			]}
			onclick={() => (mode.value = tab.mode)}
			onkeydown={(e) => handleKeydown(e, tab.mode)}
		>
			{t(tab.translationKey)}
			{#if tab.size}
				{#await tab.size() then size}
					{formatFileSize(size)}
				{/await}
			{/if}
		</div>
	{/each}
</div>

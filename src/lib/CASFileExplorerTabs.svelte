<script module lang="ts">
	import formatFileSize from "src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorer.svelte";
	import { casMetadataSave } from "src/events";
	import { debounce } from "obsidian";

	const { t } = defineLocales({
		en: {
			all: "Local",
			unreferenced: "Unreferenced",
			recycleBin: "Recycle Bin",
			mode: "Mode",
			activeNote: "Active Note",
		},
		zh: {
			all: "本地",
			unreferenced: "未引用",
			recycleBin: "回收站",
			mode: "模式",
			activeNote: "当前笔记",
		},
	});
</script>

<script lang="ts">
	const { casMetadata, mode } = getContext();
	let estimateStorage = $state(casMetadata.estimateStorage());
	const updateEstimateStorage = debounce(() => {
		estimateStorage = casMetadata.estimateStorage();
	}, 100);
	$effect(() => {
		return casMetadataSave.subscribe(() => {
			updateEstimateStorage();
		});
	});
	const views = [Mode.LOCAL, Mode.UNREFERENCED, Mode.RECYCLE_BIN];
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
	const normalBytes = $derived.by(async () => {
		const { normalBytes } = await estimateStorage;
		return normalBytes;
	});
	const trashBytes = $derived.by(async () => {
		const { trashBytes } = await estimateStorage;
		return trashBytes;
	});
	// 定义标签配置，只包含每个标签特有的属性
	const tabs = [
		{
			mode: Mode.LOCAL,
			translationKey: "all" as const,
			size: () => normalBytes,
		},
		{
			mode: Mode.ACTIVE_NOTE,
			translationKey: "activeNote" as const,
		},
		{
			mode: Mode.UNREFERENCED,
			translationKey: "unreferenced" as const,
		},
		{
			mode: Mode.RECYCLE_BIN,
			size: () => trashBytes,
			translationKey: "recycleBin" as const,
		},
	];
</script>

<div
	role="tablist"
	aria-label={t("mode")}
	class="flex flex-col gap-1 @sm:flex-row @sm:gap-0"
>
	{#each tabs as tab, index (tab.mode)}
		<div
			role="tab"
			tabindex={mode.value === tab.mode ? 0 : -1}
			aria-selected={mode.value === tab.mode}
			class={[
				"flex-auto whitespace-pre px-4 py-2 text-sm  cursor-pointer select-none transition duration-300",
				mode.value === tab.mode
					? "text-on-accent bg-interactive-accent font-semibold hover:bg-interactive-accent-hover"
					: "text-normal bg-interactive-normal hover:bg-interactive-hover ",
				index === 0 && "@sm:rounded-l-sm",
				index === tabs.length - 1 && "@sm:rounded-r-sm",
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

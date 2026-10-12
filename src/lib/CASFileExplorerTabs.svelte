<script module lang="ts">
	import formatFileSize from "#src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import { getContext, Mode } from "./CASFileExplorerContext";
	import { casMetadataDelete, casMetadataSave } from "#src/events";
	import staleWithRevalidate from "./stores/staleWhileRevalidate.svelte";
	import { debounce } from "obsidian";

	const { t } = defineLocales({
		en: {
			all: "Local",
			unreferenced: "Unreferenced",
			recycleBin: "Recycle bin",
			mode: "Mode",
			activeNote: "Active note",
			downloads: "Downloads",
		},
		zh: {
			all: "本地",
			unreferenced: "未引用",
			recycleBin: "回收站",
			mode: "模式",
			activeNote: "当前笔记",
			downloads: "下载",
		},
	});
</script>

<script lang="ts">
	const { casMetadata, mode, getDownloadDirs } = getContext();

	// 增量索引期间保存/删除事件密集到达，去抖合并成一次统计查询，
	// 避免把每个事件都打成一趟 IndexedDB 扫描
	let estimateVersion = $state(0);
	const scheduleEstimateRefresh = debounce(() => {
		estimateVersion += 1;
	}, 100);
	$effect(() => {
		// 唯一副本删净且无引用时走的是删除事件，两种事件都要响应，
		// 否则清空回收站/清理后占用数字会停在清理前
		const refresh = () => scheduleEstimateRefresh();
		const unsubscribes = [
			casMetadataSave.subscribe(refresh),
			casMetadataDelete.subscribe(refresh),
		];
		return () => {
			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
		};
	});

	// 三个标签的占用共享同一次统计，重算期间沿用上一次的数字并脉冲提示，
	// 而不是撤下内容换成骨架：占用是持续存在的指标，闪断只会让人以为在加载
	const { result: storage, isStale } = staleWithRevalidate(() => {
		void estimateVersion;
		return casMetadata.estimateStorage();
	});

	const normalBytes = $derived($storage?.normalBytes);
	const trashBytes = $derived($storage?.trashBytes);
	const downloadBytes = $derived.by(() => {
		const dirBytes = $storage?.dirBytes;
		if (!dirBytes) {
			return undefined;
		}
		const dirs = new Set(getDownloadDirs());
		return Object.entries(dirBytes).reduce(
			(sum, [dir, bytes]) => (dirs.has(dir) ? sum + bytes : sum),
			0,
		);
	});

	const views = [
		Mode.LOCAL,
		Mode.UNREFERENCED,
		Mode.RECYCLE_BIN,
		Mode.DOWNLOADS,
	];
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
		{
			mode: Mode.DOWNLOADS,
			size: () => downloadBytes,
			translationKey: "downloads" as const,
		},
	];
</script>

<div
	role="tablist"
	aria-label={t("mode")}
	class="flex flex-col flex-wrap gap-1 @sm:flex-row @sm:gap-0"
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
				{@const size = tab.size()}
				{#if size !== undefined}
					<!-- 只脉冲数字，标签文字保持稳定 -->
					<span class={$isStale ? "animate-pulse" : ""}
						>{formatFileSize(size)}</span
					>
				{/if}
			{/if}
		</div>
	{/each}
</div>

<script lang="ts" module>
	import defineLocales from "src/utils/defineLocales";

	const { t } = defineLocales({
		en: {
			indexing: "Updating index...",
		},
		zh: {
			indexing: "正在更新索引...",
		},
	});
</script>

<script lang="ts">
	import ProgressBar from "./ProgressBar.svelte";

	const { totalFiles }: { totalFiles: number } = $props();

	let currentIndex = $state(0);
	let currentFile = $state("");

	export { currentIndex, currentFile };
</script>

<div class="w-64">
	<div>{t("indexing")}</div>
	<ProgressBar value={currentIndex} max={totalFiles} showPercent />
	<div>{currentFile}</div>
</div>

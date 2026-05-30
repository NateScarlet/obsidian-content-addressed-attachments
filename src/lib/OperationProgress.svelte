<script lang="ts" module>
	import defineLocales from "#src/utils/defineLocales";

	const { t } = defineLocales({
		en: {
			processed: "Processed:",
		},
		zh: {
			processed: "已处理:",
		},
	});
</script>

<script lang="ts">
	import ProgressBar from "./ProgressBar.svelte";

	const { title }: { title: string } = $props();

	let currentIndex = $state(0);
	let currentFile = $state("");

	export { currentIndex, currentFile };
</script>

<div class="w-64">
	<div class="font-bold mb-1">{title}</div>
	<div class="text-sm opacity-50 mb-1">
		{t("processed")}
		{currentIndex}
	</div>
	<ProgressBar value={currentIndex} max={0} />
	<div class="text-xs truncate text-muted">{currentFile}</div>
</div>

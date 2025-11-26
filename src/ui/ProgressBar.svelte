<script lang="ts">
	import roundDecimal from "src/utils/roundDecimal";

	const {
		value,
		max,
		showPercent,
	}: { value: number; max: number; showPercent?: boolean } = $props();

	const percent = $derived(roundDecimal((value / max) * 100, 2));
</script>

<div class="relative flex items-center">
	<div class="bg-primary/50 flex-auto h-2">
		<div
			class="bg-accent h-2 animate-pulse"
			style:width="{percent}%"
		></div>
	</div>
	{#if showPercent}
		<span class="flex-none w-14 text-sm text-right">
			{percent} %
		</span>
	{/if}
</div>

<script lang="ts">
	import roundDecimal from "#src/utils/roundDecimal";

	const {
		value,
		max,
		showPercent,
	}: { value: number; max: number; showPercent?: boolean } = $props();

	const percent = $derived(
		max > 0 ? roundDecimal((value / max) * 100, 2) : 100,
	);
</script>

<div class="relative flex items-center">
	<div class="bg-primary/50 flex-auto h-2 overflow-hidden">
		<div
			class="bg-accent h-2 {max > 0 ? '' : 'animate-pulse'}"
			style:width="{percent}%"
		></div>
	</div>
	{#if showPercent && max > 0}
		<span class="flex-none w-14 text-sm text-right">
			{percent} %
		</span>
	{/if}
</div>

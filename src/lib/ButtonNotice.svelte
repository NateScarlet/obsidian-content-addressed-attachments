<script lang="ts">
	const {
		message,
		onclick,
		label,
		icon,
	}: {
		message: string;
		onclick: (e: MouseEvent) => void;
		icon?: { pathData: string };
		label?: string;
	} = $props();
</script>

<button type="button" class="w-full flex items-center justify-center" {onclick}>
	{#if icon}
		<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
			<path d={icon.pathData} />
		</svg>
	{/if}
	<wbr />
	{label}</button
>
<div class="text-center m-2">{message}</div>

<script lang="ts">
	import type { Component } from "svelte";
	import {
		setContext,
		type CASFileExplorerContext,
	} from "#src/lib/CASFileExplorerContext";

	// 不解构 $props：setContext 需要的是初始值本身，不参与后续响应
	const props: {
		value: CASFileExplorerContext;
		component: Component;
	} = $props();

	// svelte-ignore state_referenced_locally -- context 只在挂载时写入一次，取快照是本意
	setContext(props.value);
</script>

<props.component />
<script module lang="ts">
	import defineLocales from "#src/utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			scriptURLPlaceholder:
				"Vault-relative path, ipfs://, internal.ipfs-locked:, or https:// URL. Add parameters in fragment (e.g. #quality=80)",
			preProcessScriptName: "Pre-processing script",
		},
		zh: {
			scriptURLPlaceholder:
				"Vault 相对路径、ipfs://、internal.ipfs-locked: 或 https:// URL。在 fragment 中添加参数（如 #quality=80）",
			preProcessScriptName: "预处理脚本",
		},
	});
	//#endregion
</script>

<script lang="ts">
	import clsx from "clsx";
	import type { ScriptIndexEntry } from "#src/preprocess/types";
	import textAreaAutoHeight from "./attachments/textareaAutoHeight.svelte";

	const {
		value,
		entries,
		customScriptLabel,
		disabledLabel,
		findScriptByURL,
		onChange,
	}: {
		value: string;
		entries: ScriptIndexEntry[];
		customScriptLabel: string;
		disabledLabel: string;
		findScriptByURL: (scriptURL: string) => ScriptIndexEntry | undefined;
		onChange: (value: string) => void;
	} = $props();

	// textarea 内容缓冲：undefined 表示尚未编辑，回退到外部 value
	let textBuffer = $state<string>();
	let focused = $state(false);
	let activeIndex = $state(0);

	/** 当前显示的文本：编辑缓冲优先，否则回退初始值 */
	const currentText = $derived(textBuffer ?? value);

	/** 根据当前输入值推导设置项描述 */
	const description = $derived.by(() => {
		const entry = findScriptByURL(currentText);
		if (entry) return `${entry.description} (${entry.name})`;
		if (currentText.trim()) return customScriptLabel;
		return disabledLabel;
	});

	/** 过滤下拉选项：按名称/描述/URL 模糊匹配；无匹配时回退为全部条目，保证点击即见列表 */
	const filtered = $derived.by(() => {
		const query = currentText.trim().toLowerCase();
		if (!query) return entries;
		const matches = entries.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query) ||
				entry.scriptURL.toLowerCase().includes(query),
		);
		return matches.length > 0 ? matches : entries;
	});

	function handleInput(text: string): void {
		textBuffer = text;
		focused = true;
		activeIndex = 0;
		onChange(text);
	}

	function handleSelect(entry: ScriptIndexEntry): void {
		textBuffer = entry.scriptURL;
		focused = false;
		onChange(entry.scriptURL);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (!focused) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			activeIndex = (activeIndex + 1) % filtered.length;
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			activeIndex =
				(filtered.length + activeIndex - 1) % filtered.length;
		} else if (event.key === "Enter") {
			event.preventDefault();
			const entry = filtered[activeIndex];
			if (entry) handleSelect(entry);
		} else if (event.key === "Escape") {
			event.preventDefault();
			focused = false;
		}
	}
</script>

<div class="setting-item flex-col items-stretch gap-2 border-none py-2">
	<div class="setting-item-info">
		<div class="setting-item-name">{t("preProcessScriptName")}</div>
		<div class="setting-item-description">{description}</div>
	</div>

	<div class="relative w-full">
		<textarea
			{@attach textAreaAutoHeight(() => currentText)}
			class="w-full resize-none rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] px-3 py-2 text-xs font-mono text-theme-text break-all"
			rows={2}
			value={currentText}
			placeholder={t("scriptURLPlaceholder")}
			oninput={(e) => handleInput((e.target as HTMLTextAreaElement).value)}
			onfocus={() => {
				focused = true;
				activeIndex = 0;
			}}
			onblur={() => {
				// 延迟关闭，允许下拉项点击先触发
				window.setTimeout(() => {
					focused = false;
				}, 150);
			}}
			onkeydown={handleKeydown}
		></textarea>

		{#if focused && filtered.length > 0}
			<div
				class="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-[var(--background-modifier-border)] bg-[var(--background-primary)] shadow-md"
			>
				{#each filtered as entry, index (entry.scriptURL)}
					<button
						type="button"
						class={clsx(
							"flex w-full flex-col gap-0.5 border-none px-3 py-1.5 text-left",
							index === activeIndex
								? "bg-[var(--background-modifier-hover)]"
								: "bg-transparent",
						)}
						onmouseenter={() => {
							activeIndex = index;
						}}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => handleSelect(entry)}
					>
						<span class="text-xs font-medium text-normal">
							{entry.name}
						</span>
						<span class="text-xs font-mono text-muted break-all">
							{entry.scriptURL}
						</span>
						{#if entry.description}
							<span class="text-xs text-muted">
								{entry.description}
							</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

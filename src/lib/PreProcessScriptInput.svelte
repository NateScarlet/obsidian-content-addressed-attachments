<script module lang="ts">
	import defineLocales from "#src/utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			scriptURLPlaceholder:
				"Vault-relative path, ipfs://, internal.ipfs-locked:, or https:// URL. Add parameters in fragment (e.g. #quality=80)",
			preProcessScriptName: "Pre-processing script",
			devGuideLink: "Script Development Guide",
			devGuideUrl:
				"https://github.com/NateScarlet/obsidian-content-addressed-attachments/blob/main/docs/preprocess-scripts.en.md",
		},
		zh: {
			scriptURLPlaceholder:
				"Vault 相对路径、ipfs://、internal.ipfs-locked: 或 https:// URL。在 fragment 中添加参数（如 #quality=80）",
			preProcessScriptName: "预处理脚本",
			devGuideLink: "脚本开发指南",
			devGuideUrl:
				"https://github.com/NateScarlet/obsidian-content-addressed-attachments/blob/main/docs/preprocess-scripts.zh-CN.md",
		},
	});
	//#endregion
</script>

<script lang="ts">
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
	let textareaEl = $state<HTMLTextAreaElement>();

	/** 当前显示的文本：编辑缓冲优先，否则回退初始值 */
	const currentText = $derived(textBuffer ?? value);

	/** 当前匹配到的预设条目 */
	const matchedEntry = $derived(findScriptByURL(currentText));

	/** 当前下拉菜单选中项 key */
	const selectedDropdownValue = $derived.by(() => {
		if (!currentText.trim()) return "disabled";
		if (matchedEntry) return "preset:" + matchedEntry.scriptURL;
		return "custom";
	});

	/** 根据当前输入值推导设置项描述 */
	const description = $derived.by(() => {
		if (matchedEntry) return matchedEntry.description;
		if (currentText.trim()) return customScriptLabel;
		return disabledLabel;
	});

	function handleInput(text: string): void {
		textBuffer = text;
		onChange(text);
	}

	function handleSelectChange(e: Event): void {
		const target = e.target as HTMLSelectElement;
		const val = target.value;

		if (val === "disabled") {
			textBuffer = "";
			onChange("");
		} else if (val.startsWith("preset:")) {
			const scriptURL = val.slice("preset:".length);
			textBuffer = scriptURL;
			onChange(scriptURL);
		} else if (val === "custom") {
			if (matchedEntry) {
				// 如果原本是预设，保留文本以便修改
			} else if (!currentText.trim()) {
				textBuffer = "";
			}
			window.setTimeout(() => textareaEl?.focus(), 50);
		}
	}
</script>

<div class="setting-item flex-wrap">
	<div class="setting-item-info">
		<div class="setting-item-name">
			{t("preProcessScriptName")}
			<a
				href={t("devGuideUrl")}
				target="_blank"
				rel="noopener noreferrer"
				class="external-link ml-2 font-normal opacity-70 hover:opacity-100"
			>
				{t("devGuideLink")}
			</a>
		</div>
		<div class="setting-item-description">{description}</div>
	</div>

	<div class="setting-item-control">
		<select
			class="dropdown"
			value={selectedDropdownValue}
			onchange={handleSelectChange}
		>
			<option value="disabled">{disabledLabel}</option>
			{#each entries as entry (entry.scriptURL)}
				<option value={"preset:" + entry.scriptURL}>{entry.name}</option>
			{/each}
			<option value="custom">{customScriptLabel}</option>
		</select>
	</div>

	{#if selectedDropdownValue !== "disabled" || currentText.trim()}
		<div class="mt-2 w-full">
			<textarea
				bind:this={textareaEl}
				{@attach textAreaAutoHeight(() => currentText)}
				class="w-full resize-none rounded border border-border bg-primary px-3 py-2 text-xs font-mono text-normal break-all focus:border-interactive-accent focus:outline-none"
				rows={2}
				value={currentText}
				placeholder={t("scriptURLPlaceholder")}
				spellcheck="false"
				oninput={(e) => handleInput((e.target as HTMLTextAreaElement).value)}
			></textarea>
		</div>
	{/if}
</div>


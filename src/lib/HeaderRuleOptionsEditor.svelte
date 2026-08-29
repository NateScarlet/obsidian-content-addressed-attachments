<script module lang="ts">
	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			baseUrl: "Base URL (prefix match)",
			baseUrlPlaceholder: "e.g.: https://source.example.com",
			headers: "Headers",
			headersDescription:
				"One header per line, format: Header-Name: header value",
			headersPlaceholder:
				"e.g.:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
			delete: "Delete rule",
		},
		zh: {
			baseUrl: "Base URL（前缀匹配）",
			baseUrlPlaceholder: "例如: https://source.example.com",
			headers: "请求头",
			headersDescription:
				"每行一个请求头，格式为: Header-Name: header value",
			headersPlaceholder:
				"例如:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
			delete: "删除规则",
		},
	});
	//#endregion
</script>

<script lang="ts">
	import type { HeaderRule } from "#src/URLResolver";
	import defineLocales from "#src/utils/defineLocales";
	import textAreaAutoHeight from "./attachments/textareaAutoHeight.svelte";
	import { mdiTrashCanOutline } from "@mdi/js";

	const {
		config,
		updateConfig,
		deleteConfig,
	}: {
		config: Readonly<HeaderRule>;
		updateConfig: (config: HeaderRule) => void;
		deleteConfig: () => void;
	} = $props();

	let baseUrlBuffer = $state<string>();
	const baseUrlModel = {
		get value() {
			return baseUrlBuffer ?? config.baseUrl;
		},
		set value(value: string) {
			baseUrlBuffer = value;
			updateConfig({ ...config, baseUrl: value });
		},
	};

	let headerTextBuffer = $state<string>();
	const headerTextModel = {
		get value() {
			return (
				headerTextBuffer ??
				config.headers
					.map(([key, value]) => `${key}: ${value}`)
					.join("\n")
			);
		},
		set value(text: string) {
			headerTextBuffer = text;

			const headers: [key: string, value: string][] = [];
			const lines = text.split("\n");

			for (const line of lines) {
				const trimmedLine = line.trim();
				if (!trimmedLine) continue;

				const colonIndex = trimmedLine.indexOf(":");
				if (colonIndex === -1) {
					// 如果没有冒号，跳过这一行
					continue;
				}

				const key = trimmedLine.substring(0, colonIndex).trim();
				const value = trimmedLine.substring(colonIndex + 1).trim();

				if (key) {
					headers.push([key, value]);
				}
			}

			updateConfig({ ...config, headers });
		},
	};
</script>

<div class="flex flex-col gap-2">
	<label class="space-y-1">
		<span>{t("baseUrl")}</span>
		<input
			class="w-full"
			type="text"
			bind:value={baseUrlModel.value}
			placeholder={t("baseUrlPlaceholder")}
		/>
	</label>

	<label class="space-y-1">
		<span>{t("headers")}</span>
		<div class="text-base-500">{t("headersDescription")}</div>
		<textarea
			{@attach textAreaAutoHeight(() => headerTextModel.value)}
			class="w-full min-h-32 resize-none font-mono"
			bind:value={headerTextModel.value}
			placeholder={t("headersPlaceholder")}
		></textarea>
	</label>

	<div>
		<button
			type="button"
			class="bg-error! text-primary!"
			onclick={() => deleteConfig()}
		>
			<svg class="inline fill-current h-[1.25em]" viewBox="0 0 24 24">
				<path d={mdiTrashCanOutline} />
			</svg>
			<span>{t("delete")}</span>
		</button>
	</div>
</div>

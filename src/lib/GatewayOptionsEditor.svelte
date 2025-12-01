<script module lang="ts">
	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			headers: "Headers",
			headersDescription:
				"One header per line, format: Header-Name: header value",
			headersPlaceholder:
				"e.g.:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		},
		zh: {
			headers: "请求头",
			headersDescription:
				"每行一个请求头，格式为: Header-Name: header value",
			headersPlaceholder:
				"例如:\nAuthorization: Bearer token\nUser-Agent: MyApp/1.0",
		},
	});
	//#endregion
</script>

<script lang="ts">
	import type { GatewayURLConfig } from "src/URLResolver";
	import defineLocales from "src/utils/defineLocales";
	import textAreaAutoHeight from "./attachments/textareaAutoHeight.svelte";

	const {
		config,
		updateConfig,
	}: {
		config: Readonly<GatewayURLConfig>;
		updateConfig: (config: GatewayURLConfig) => void;
	} = $props();

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

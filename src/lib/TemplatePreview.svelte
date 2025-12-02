<script module lang="ts">
	import defineLocales from "../utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			preview: "Preview",
			previewDesc: "Real-time preview based on example IPFS URL",
			exampleURL: "Example URL for preview",
			renderedURL: "Rendered URL",
			error: "Error",
			focusToPreview: "Focus on a URL template input to see preview",
		},
		zh: {
			preview: "预览",
			previewDesc: "基于示例IPFS URL的实时预览",
			exampleURL: "用于预览的示例URL",
			renderedURL: "渲染后的URL",
			error: "错误",
			focusToPreview: "聚焦到URL模板输入框以查看预览",
		},
	});
	//#endregion
</script>

<script lang="ts">
	import clsx from "clsx";
	import type { GatewayConfig, URLResolver } from "src/URLResolver";
	import castError from "../utils/castError";
	import { EXAMPLE_URL } from "src/settings";

	const config: GatewayConfig | undefined = $state();
	const { urlResolver }: { urlResolver: URLResolver } = $props();

	const preview = $derived.by(() => {
		if (config?.urlTemplate) {
			try {
				const renderedURL = urlResolver.renderGatewayURL(
					EXAMPLE_URL,
					config,
				);
				return {
					text: renderedURL,
					class: clsx`text-normal`,
				};
			} catch (error) {
				return {
					text: `${t("error")}: ${castError(error).message}`,
					class: clsx`text-error border-color-red`,
				};
			}
		}
		return {
			text: t("focusToPreview"),
			class: clsx`text-muted italic`,
		};
	});
	export { config };
</script>

<div class="my-4 p-3 border rounded-md bg-secondary text-sm template-preview">
	<!-- 预览标题 -->
	<div class="font-semibold mb-2 text-normal">{t("preview")}</div>
	<div class="text-xs text-muted mb-3">{t("previewDesc")}</div>

	<!-- 示例URL说明 -->
	<div class="font-semibold mb-1 text-xs text-muted">
		{t("exampleURL")}
	</div>

	<!-- 示例URL显示 -->
	<div class="font-mono text-xs text-base-600 mb-3 break-all">
		{EXAMPLE_URL}
	</div>

	<!-- 预览标题 -->
	<div class="font-semibold mb-1 text-xs text-muted">
		{t("renderedURL")}
	</div>

	<!-- 预览结果显示区域 -->
	<div
		class="font-mono text-sm break-all p-1 bg-primary rounded-sm border min-h-[20px] {preview.class}"
	>
		{preview.text}
	</div>
</div>

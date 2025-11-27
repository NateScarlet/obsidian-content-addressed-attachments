<script module lang="ts">
	import defineLocales from "../utils/defineLocales";

	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			templateSyntaxHelp: "Template Syntax Help",
			templateDescription:
				"URL templates use Mustache template syntax. The current implementation uses URL encoding instead of HTML escaping.",
			variableSubstitution:
				"Variable substitution: {{variable}} - Automatically URL encoded (using encodeURIComponent)",
			rawContent:
				"Raw content: {{{variable}}} - No encoding, outputs raw value",
			functionCall:
				"Function call: {{#function}}content{{/function}} - Calls custom function to process content",
			comment: "Comment: {{! comment }} - Not displayed in output",
			viewDocumentation: "View complete Mustache syntax documentation",
			encodingDescription: "Encoding Instructions",
			doubleBrace:
				"Double braces {{variable}} are automatically URL encoded (encodeURIComponent)",
			tripleBrace:
				"Triple braces {{{variable}}} preserve raw content without any encoding",
			availableVariables: "Available Template Variables",
			rawURL: "{{rawURL}} - Original URL used in the note",
			urlObject: "{{url}} - Parsed JavaScript URL object",
			cid: "{{cid}} - IPFS root content ID, multiformats CID object, can also be formatted directly as a string",
			pathname: "{{url.pathname}} - IPFS optional subpath",
			search: "{{url.search}} - URL parameter part",
			filename: "{{filename}} - File name (obtained from URL parameters)",
			format: "{{format}} - File format (obtained from URL parameters)",
			casPath: "{{casPath}} - Local storage relative path",
			encodeFunction:
				"{{#encodeURI}}content{{/encodeURI}} - URI encoding helper function to avoid path separator escaping (default will be escaped)",
		},
		zh: {
			templateSyntaxHelp: "模板语法说明",
			templateDescription:
				"URL 模板使用 Mustache 模板语法，当前实现使用 URL 编码而非 HTML 转义。",
			variableSubstitution:
				"变量替换: {{variable}} - 自动进行 URL 编码（使用 encodeURIComponent）",
			rawContent: "原始内容: {{{variable}}} - 不进行编码，直接输出原始值",
			functionCall:
				"函数调用: {{#function}}content{{/function}} - 调用自定义函数处理内容",
			comment: "注释: {{! comment }} - 不会在输出中显示",
			viewDocumentation: "查看完整的 Mustache 语法文档",
			encodingDescription: "编码说明",
			doubleBrace:
				"双花括号 {{variable}} 会自动进行 URL 编码（encodeURIComponent）",
			tripleBrace:
				"三花括号 {{{variable}}} 会保持原始内容，不进行任何编码",
			availableVariables: "可用模版变量",
			rawURL: "{{rawURL}} - 笔记中使用的原始URL",
			urlObject: "{{url}} - 解析后的 JavaScript URL 对象",
			cid: "{{cid}} - IPFS 根内容 ID, multiformats CID对象，也能直接格式化为字符串",
			pathname: "{{url.pathname}} - IPFS 可选子路径",
			search: "{{url.search}} - URL参数部分",
			filename: "{{filename}} - 文件名（从URL参数获取）",
			format: "{{format}} - 文件格式（从URL参数获取）",
			casPath: "{{casPath}} - 本地存储相对路径",
			encodeFunction:
				"{{#encodeURI}}内容{{/encodeURI}} - URI编码辅助函数，用于避免路径分隔符被转义（默认会被转义）",
		},
	});
	//#endregion
</script>

<div class="space-y-4 template-syntax-help">
	<!-- Mustache 语法说明 -->
	<details class="my-4">
		<summary class="cursor-pointer text-normal hover:bg-hover font-medium">
			{t("templateSyntaxHelp")}
		</summary>
		<div class="mt-3 space-y-3 pl-4 border-l-2 border-border">
			<span class="text-sm text-normal whitespace-pre-wrap"
				>{t("templateDescription")}</span
			>
			<a
				href="https://mustache.github.io/mustache.5.html"
				target="_blank"
				class="text-accent hover:text-accent-hover underline text-sm"
			>
				{t("viewDocumentation")}
			</a>

			<ul class="list-disc list-inside space-y-1 text-sm text-normal">
				<li>{t("variableSubstitution")}</li>
				<li>{t("rawContent")}</li>
				<li>{t("functionCall")}</li>
				<li>{t("comment")}</li>
				<li>{t("doubleBrace")}</li>
				<li>{t("tripleBrace")}</li>
			</ul>
		</div>
	</details>

	<!-- 可用变量说明 -->
	<details class="my-4">
		<summary class="cursor-pointer text-normal hover:bg-hover font-medium">
			{t("availableVariables")}
		</summary>
		<ul class="list-disc list-inside space-y-1 mt-3 text-sm text-normal">
			<li>{t("rawURL")}</li>
			<li>{t("urlObject")}</li>
			<li>{t("cid")}</li>
			<li>{t("pathname")}</li>
			<li>{t("search")}</li>
			<li>{t("filename")}</li>
			<li>{t("format")}</li>
			<li>{t("casPath")}</li>
			<li>{t("encodeFunction")}</li>
		</ul>
	</details>
</div>

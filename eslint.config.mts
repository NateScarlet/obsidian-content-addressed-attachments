import svelte from "eslint-plugin-svelte";
import ts from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import svelteConfig from "./svelte.config.mjs";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import replaceImport from "./scripts/eslint-rules/replace-import";

// XXX: typescript rule typing is not compatible with official defineConfig, but it works at runtime
// see https://github.com/typescript-eslint/typescript-eslint/issues/11543
type TypedDefineConfig = (
	...args: Parameters<typeof ts.config>
) => ReturnType<typeof ts.config>;

export default (defineConfig as TypedDefineConfig)([
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	{
		plugins: {
			local: {
				rules: {
					"replace-import": replaceImport,
				},
			},
		},
		rules: {
			"local/replace-import": [
				"error",
				[{ from: "multiformats/dist/src", to: "multiformats" }],
			],
		},
	},
	globalIgnores([
		"node_modules/",
		"*.js",
		"*.mjs",
		"*.json",
		"eslint.config.mts",
	]),
	{
		plugins: { obsidianmd },
	},
	...obsidianmd.configs.recommended,
	ts.configs.eslintRecommended,
	...ts.configs.recommended,
	...svelte.configs["flat/recommended"],
	prettierRecommended,
	{
		files: ["**/*.ts", "**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
		// See more details at: https://typescript-eslint.io/packages/parser/
		languageOptions: {
			parserOptions: {
				projectService: true,
				parser: ts.parser,
				extraFileExtensions: [".svelte", ".svelte.ts"],
				svelteFeatures: {
					experimentalGenerics: true,
				},
				svelteConfig,
			},
		},
	},
	{
		// XXX: 遇到冒号就报解析错误，无法使用
		files: ["**/*.svelte"],
		rules: {
			"prettier/prettier": "off",
		},
	},
]);

///@ts-check

import svelte from "eslint-plugin-svelte";
import ts from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import svelteConfig from "./svelte.config.mjs";
import prettierRecommended from "eslint-plugin-prettier/recommended";

export default defineConfig([
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	globalIgnores(["node_modules/", "*.js", "*.mjs", "*.json"]),
	// @ts-ignore
	...obsidianmd.configs.recommended,
	ts.configs.eslintRecommended,
	...ts.configs.recommended,
	svelte.configs["flat/recommended"],
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

///@ts-check

import svelte from "eslint-plugin-svelte";
import ts from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import svelteConfig from "./svelte.config.mjs";

export default defineConfig([
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	{
		plugins: {
			svelte,
			obsidianmd,
			"@typescript-eslint": ts.plugin,
		},
	},
	globalIgnores(["node_modules/", "*.js", "*.mjs", "*.json"]),
	// @ts-ignore
	...obsidianmd.configs.recommended,
	ts.configs.eslintRecommended,
	...ts.configs.recommended,
	svelte.configs["flat/recommended"],
	{
		files: ["**/*.ts", "**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
		// See more details at: https://typescript-eslint.io/packages/parser/
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				projectService: true,
				extraFileExtensions: [".svelte"],
				svelteFeatures: {
					experimentalGenerics: true,
				},
				svelteConfig,
			},
		},
	},
]);

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import svelte from "eslint-plugin-svelte";
import ts from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import svelteConfig from "./svelte.config.mjs";

export default defineConfig([
	globalIgnores(["node_modules/", "*.js", "*.mjs", "*.json"]),
	...obsidianmd.configs.recommended,
	...svelte.configs.recommended,
	{
		files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
		// See more details at: https://typescript-eslint.io/packages/parser/
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: [".svelte", ".svelte.ts"],
				parser: ts.parser,
				svelteFeatures: {
					experimentalGenerics: true,
				},
				svelteConfig,
			},
		},
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parser: ts.parser,
			parserOptions: {
				sourceType: "module",
				project: "./tsconfig.json",
			},
		},
		plugins: {
			obsidianmd,
			"@typescript-eslint": ts.plugin,
		},
		rules: {
			"no-undef": "off",
		},
	},
]);

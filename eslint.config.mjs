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
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
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
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					args: "all",
					argsIgnorePattern: "^_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
		},
	},
	{
		rules: {
			"no-undef": "off",
			"no-unused-vars": "off",
		},
	},
]);

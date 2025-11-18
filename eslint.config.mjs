import tsparser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	globalIgnores(["node_modules/", "main.js", "*.mjs"]),
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parser: tsparser,
			parserOptions: {
				sourceType: "module",
				project: "./tsconfig.json",
			},
		},
		plugins: {
			obsidianmd,
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			"no-undef": false,
		},
	},
]);

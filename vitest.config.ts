/* eslint-disable import/no-nodejs-modules -- vitest config requires Node.js builtins */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	resolve: {
		alias: {
			"#src": path.resolve(__dirname, "./src"),
			obsidian: path.resolve(__dirname, "./src/__mocks__/obsidian.ts"),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		setupFiles: ["./test/setupTests.ts"],
	},
});

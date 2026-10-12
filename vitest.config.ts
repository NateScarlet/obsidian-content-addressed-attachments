/* eslint-disable import/no-nodejs-modules -- vitest config requires Node.js builtins */
import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { sveltePreprocess } from "svelte-preprocess";

// --configLoader native 下配置以原生 ESM 加载，不存在 __dirname，改由 import.meta.url 推导
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [
		// 让能以纯 node 加载 svelte 组件（ReferenceManager 接缝测试 import 的 .svelte）
		svelte({
			configFile: false,
			preprocess: sveltePreprocess(),
			compilerOptions: { runes: true },
		}),
	],
	resolve: {
		alias: {
			"#src": path.resolve(dirname, "./src"),
			obsidian: path.resolve(dirname, "./src/__mocks__/obsidian.ts"),
		},
		// svelte 只导出 client/server 两套入口，没有 node 条件，
		// 组件测试要 mount 组件必须解析到 client 入口
		// （直接依赖中另一处 browser 条件是 multiformats 的 hashes/sha*，
		//   其 encode 变异步但仓库内全部 await 调用，行为不变）
		conditions: ["browser"],
	},
	test: {
		include: ["src/**/*.test.ts", "preprocess-scripts/**/*.test.ts"],
		setupFiles: ["./test/setupTests.ts"],
		// DSH 受限沙箱禁止子进程 stdio 管道，默认的 forks pool（子进程）无法启动；
		// threads 使用进程内 worker_threads，测试隔离在线程级进行
		pool: "threads",
	},
});

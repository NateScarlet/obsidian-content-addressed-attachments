// 预处理脚本构建配置（rolldown-vite 8）。
// 由 scripts/build-preprocess-scripts.mjs 调用 build()（进程内，沙箱免疫）。
// 多入口经 build.lib.entry 对象形式声明（key 即 entryName，供 fileName 使用），
// 见 https://vite.dev/config/build-options#build-lib
import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { builtinModules } from "node:module";

const dirname_ = dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
	const dist = resolve(dirname_, "dist", "preprocess-scripts");

	return {
		build: {
			outDir: dist,
			emptyOutDir: false,
			lib: {
				// key = entryName（传入 fileName），value = 相对 root 的入口路径
				entry: {
					imagemagick: "preprocess-scripts/imagemagick.ts",
					"imagemagick.worker":
						"preprocess-scripts/imagemagick.worker.ts",
				},
				formats: ["es"],
				fileName: (_format, entryName) => `${entryName}.js`,
			},
			target: "es2020",
			minify: true,
			sourcemap: false,
			rollupOptions: {
				external: [
					...builtinModules,
					...builtinModules.map((m) => `node:${m}`),
				],
			},
		},
	};
});

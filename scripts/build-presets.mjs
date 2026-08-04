/**
 * 构建预设脚本。
 *
 * 将 preset-scripts/ 中的 JS 文件打包为单文件 bundle，
 * 输出到 dist/presets/ 目录。
 *
 * 预设脚本是独立的 ES module，通过 plugin 的预处理管线动态 import() 加载。
 * 它们不经过 esbuild 打包，直接复制并确保是有效的 JS 模块。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetSrcDir = resolve(root, "preset-scripts");
const presetDistDir = resolve(root, "dist", "presets");

const presets = ["avif.js", "webp.js"];

if (!existsSync(presetDistDir)) {
	mkdirSync(presetDistDir, { recursive: true });
}

for (const preset of presets) {
	const srcPath = resolve(presetSrcDir, preset);
	const distPath = resolve(presetDistDir, preset);

	const content = readFileSync(srcPath, "utf-8");
	writeFileSync(distPath, content, "utf-8");

	console.log(`Built preset: ${preset} -> ${distPath}`);
}

console.log("All presets built successfully.");
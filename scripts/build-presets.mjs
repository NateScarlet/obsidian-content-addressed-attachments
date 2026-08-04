/**
 * 构建预设脚本。
 *
 * 使用 esbuild 将 ImageMagick WASM 预设脚本打包为单文件 bundle，
 * 输出到 dist/presets/ 目录。
 * 同时复制 magick.wasm 文件到同一目录。
 */

import { copyFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetSrcDir = resolve(root, "pre-process-presets");
const presetDistDir = resolve(root, "dist", "presets");
const wasmSrc = resolve(
	root,
	"node_modules",
	"@imagemagick",
	"magick-wasm",
	"dist",
	"magick.wasm",
);

const presets = ["imagemagick.js"];

if (!existsSync(presetDistDir)) {
	mkdirSync(presetDistDir, { recursive: true });
}

for (const preset of presets) {
	const srcPath = resolve(presetSrcDir, preset);
	const distPath = resolve(presetDistDir, preset);

	await esbuild.build({
		entryPoints: [srcPath],
		outfile: distPath,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2020",
		minify: true,
	});

	console.log(`Built preset: ${preset} -> ${distPath}`);
}

// 复制 magick.wasm
if (existsSync(wasmSrc)) {
	const wasmDist = resolve(presetDistDir, "magick.wasm");
	copyFileSync(wasmSrc, wasmDist);
	console.log(`Copied: magick.wasm -> ${wasmDist}`);
} else {
	console.warn("Warning: magick.wasm not found at", wasmSrc);
}

console.log("All presets built successfully.");
/**
 * 构建预设脚本并生成清单文件。
 *
 * 使用 esbuild 将 ImageMagick WASM 预设脚本打包为单文件 bundle，
 * 输出到 dist/presets/ 目录。
 * 同时复制 magick.wasm 文件到同一目录，并生成 preset-index.json 清单。
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
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

const presets = ["imagemagick.ts"];

if (!existsSync(presetDistDir)) {
	mkdirSync(presetDistDir, { recursive: true });
}

/** 计算文件的 CID (v1, raw codec, SHA-256) */
async function computeCID(filePath: string): Promise<string> {
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

// 构建 manifest 清单条目
const manifestFiles: Record<string, { cid: string }> = {};

for (const preset of presets) {
	const srcPath = resolve(presetSrcDir, preset);
	const distPath = resolve(presetDistDir, preset.replace(/\.ts$/, ".js"));

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

	// 计算打包后文件的 CID
	const cid = await computeCID(distPath);
	const filename = preset.replace(/\.ts$/, ".js");
	manifestFiles[filename] = { cid };
	console.log(`  CID: ${cid}`);
}

// 复制 magick.wasm 并计算 CID
if (existsSync(wasmSrc)) {
	const wasmDist = resolve(presetDistDir, "magick.wasm");
	copyFileSync(wasmSrc, wasmDist);
	console.log(`Copied: magick.wasm -> ${wasmDist}`);
	const wasmCID = await computeCID(wasmDist);
	manifestFiles["magick.wasm"] = { cid: wasmCID };
	console.log(`  CID: ${wasmCID}`);
} else {
	console.warn("Warning: magick.wasm not found at", wasmSrc);
}

// 生成清单文件
const entry = presets[0].replace(/\.ts$/, ".js");
const manifest = {
	entry,
	files: manifestFiles,
};
const manifestPath = resolve(presetDistDir, "preset-index.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Generated manifest: ${manifestPath}`);

// 计算清单文件自身的 CID
const manifestCID = await computeCID(manifestPath);
console.log(`Manifest CID: ${manifestCID}`);

console.log("All presets built successfully.");
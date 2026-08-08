/**
 * 构建预处理脚本并生成清单文件。
 *
 * 使用 esbuild 将 ImageMagick WASM 预处理脚本打包为单文件 bundle，
 * 输出到 dist/preprocess-scripts/ 目录。
 * 同时复制 magick.wasm 文件到同一目录，并生成 per-script 清单文件。
 *
 * 清单中 sources 优先使用 vault-relative 路径（开发环境），
 * 其次为 release asset HTTPS URL（<TAG> 占位符由 update-preprocess-index.mjs 替换）。
 * CID 直接写入清单，下游直接读取即可。
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scriptSrcDir = resolve(root, "preprocess-scripts");
const scriptDistDir = resolve(root, "dist", "preprocess-scripts");
const wasmSrc = resolve(
	root,
	"node_modules",
	"@imagemagick",
	"magick-wasm",
	"dist",
	"magick.wasm",
);

/** 开发环境 vault-relative 路径前缀 */
const VAULT_RELATIVE_PREFIX =
	".obsidian/plugins/content-addressed-attachments/dist/preprocess-scripts";

/** release asset 下载 URL 模板 */
const RELEASE_ASSET_URL =
	"https://github.com/NateScarlet/obsidian-content-addressed-attachments/releases/download/<TAG>/";

const scripts = ["imagemagick.ts"];

if (!existsSync(scriptDistDir)) {
	mkdirSync(scriptDistDir, { recursive: true });
}

/** 计算文件的 CID (v1, raw codec, SHA-256) */
async function computeCID(filePath) {
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

// 构建脚本
for (const script of scripts) {
	const srcPath = resolve(scriptSrcDir, script);
	const distPath = resolve(scriptDistDir, script.replace(/\.ts$/, ".js"));

	await esbuild.build({
		entryPoints: [srcPath],
		outfile: distPath,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2020",
		minify: true,
	});

	console.log(`Built script: ${script} -> ${distPath}`);
}

// 复制 magick.wasm
if (existsSync(wasmSrc)) {
	const wasmDist = resolve(scriptDistDir, "magick.wasm");
	copyFileSync(wasmSrc, wasmDist);
	console.log(`Copied: magick.wasm -> ${wasmDist}`);
} else {
	console.warn("Warning: magick.wasm not found at", wasmSrc);
}

// 为每个脚本生成 per-script 清单文件
for (const script of scripts) {
	const filename = script.replace(/\.ts$/, ".js");
	const filePath = resolve(scriptDistDir, filename);
	const cid = await computeCID(filePath);

	// 收集该脚本依赖的额外文件
	const extraFiles = [];
	if (script === "imagemagick.ts" && existsSync(wasmSrc)) {
		const wasmDist = resolve(scriptDistDir, "magick.wasm");
		const wasmCID = await computeCID(wasmDist);
		extraFiles.push({ filename: "magick.wasm", cid: wasmCID });
	}

	// sources：相对路径在前（开销小），HTTPS URL 在后（发布时引用）
	const manifestFiles = {
		[filename]: {
			cid,
			sources: [
				`${VAULT_RELATIVE_PREFIX}/${filename}`,
				`${RELEASE_ASSET_URL}${filename}`,
			],
		},
	};
	for (const extra of extraFiles) {
		manifestFiles[extra.filename] = {
			cid: extra.cid,
			sources: [
				`${VAULT_RELATIVE_PREFIX}/${extra.filename}`,
				`${RELEASE_ASSET_URL}${extra.filename}`,
			],
		};
	}

	const manifest = {
		entry: filename,
		files: manifestFiles,
	};

	const manifestName = script.replace(/\.ts$/, ".json");
	const manifestPath = resolve(scriptDistDir, manifestName);
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	console.log(`Generated manifest: ${manifestPath}`);
	console.log(`  ${filename}: ${cid}`);
}

// 自动同步开发模式索引文件 src/preprocess/script-index.generated.json
const registryPath = resolve(root, "preprocess-scripts", "registry.json");
const scriptIndexPath = resolve(root, "src", "preprocess", "script-index.generated.json");

const entries = existsSync(registryPath)
	? JSON.parse(readFileSync(registryPath, "utf-8"))
	: [];

writeFileSync(scriptIndexPath, JSON.stringify(entries, null, "\t") + "\n", "utf-8");
console.log(`Generated script index: ${scriptIndexPath}`);

console.log("All preprocess scripts built successfully.");
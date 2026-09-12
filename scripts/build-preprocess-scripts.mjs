/**
 * 构建预处理脚本并生成清单文件（纯构建产物，不涉及运行时索引）。
 *
 * 职责：
 * 1. 使用 rolldown-vite 将 preprocess-scripts/*.ts 编译为 dist/preprocess-scripts/*.js
 * 2. 复制依赖的 WASM 文件到 dist/preprocess-scripts/
 * 3. 为每个脚本生成 per-script 清单 (.json)，包含 CID 与 sources
 *
 * 清单中 sources 优先使用 vault-relative 路径（开发环境），
 * 其次为 release asset HTTPS URL（<TAG> 占位符由 generate-preprocess-index.mjs 替换）。
 * CID 直接写入清单，下游直接读取即可。
 *
 * 注意：本脚本不负责生成 src/preprocess/script-index.generated.json，
 * 该索引由 scripts/generate-preprocess-index.mjs 负责。
 */

import { copyFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "vite";
import {
	RELEASE_ASSET_BASE_URL,
	computeCID,
	releaseAssetName,
} from "./preprocess-common.mjs";

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

/** release asset HTTPS URL 模板（<TAG> 占位符由 generate-preprocess-index.mjs 替换） */
const RELEASE_ASSET_URL = `${RELEASE_ASSET_BASE_URL}<TAG>/`;

const scripts = ["imagemagick.ts"];

if (!existsSync(scriptDistDir)) {
	mkdirSync(scriptDistDir, { recursive: true });
}

// 多入口构建：入口与产物名声明在 preprocess.vite.config.mts 的 build.lib.entry
// configLoader: 'native' 使配置由 Node 原生 ESM 加载（绕开 vite 用 esbuild
// 打包配置文件时的子进程 spawn，DSH 沙箱禁止）
console.log("Building preprocess scripts with vite...");
await build({
	configFile: resolve(__dirname, "..", "preprocess.vite.config.mts"),
	configLoader: "native",
	logLevel: "warn",
});

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
	// 配套 worker 文件（imagemagick.ts → imagemagick.worker.js）
	const baseName = script.replace(/\.ts$/, "");
	const workerDist = resolve(scriptDistDir, `${baseName}.worker.js`);
	if (existsSync(workerDist)) {
		const workerCID = await computeCID(workerDist);
		extraFiles.push({ filename: `${baseName}.worker.js`, cid: workerCID });
	}

	// sources：相对路径在前（开销小），HTTPS URL 在后（发布时引用）
	const manifestFiles = {
		[filename]: {
			cid,
			sources: [
				`${VAULT_RELATIVE_PREFIX}/${filename}`,
				`${RELEASE_ASSET_URL}${releaseAssetName(filename)}`,
			],
		},
	};
	for (const extra of extraFiles) {
		manifestFiles[extra.filename] = {
			cid: extra.cid,
			sources: [
				`${VAULT_RELATIVE_PREFIX}/${extra.filename}`,
				`${RELEASE_ASSET_URL}${releaseAssetName(extra.filename)}`,
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

console.log("All preprocess scripts built successfully.");

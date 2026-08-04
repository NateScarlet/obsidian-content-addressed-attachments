/**
 * 更新预设索引。
 *
 * 从 dist/presets/ 计算预设脚本的 CID，
 * 更新 preset-scripts/preset-index.json 中的 CID 占位符，
 * 并同步更新 src/preprocess/presetIndex.ts 中的内联索引。
 *
 * 用法: node scripts/update-preset-index.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetDistDir = resolve(root, "dist", "presets");
const presetIndexPath = resolve(root, "preset-scripts", "preset-index.json");
const presetIndexSrcPath = resolve(root, "src", "preprocess", "presetIndex.ts");

const presets = ["avif.js", "webp.js"];

async function computeCID(filePath) {
	const { CID } = await import("multiformats/cid");
	const { sha256 } = await import("multiformats/hashes/sha2");
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

async function main() {
	const cidMap = {};

	for (const preset of presets) {
		const filePath = resolve(presetDistDir, preset);
		const cid = await computeCID(filePath);
		const key = preset.replace(".js", "").toUpperCase();
		cidMap[key] = cid;
		console.log(`${preset}: ${cid}`);
	}

	// 更新 preset-index.json
	let indexContent = readFileSync(presetIndexPath, "utf-8");
	for (const [key, cid] of Object.entries(cidMap)) {
		indexContent = indexContent.replace(
			new RegExp(`<CID_${key}>`, "g"),
			cid,
		);
	}
	writeFileSync(presetIndexPath, indexContent, "utf-8");
	console.log("Updated preset-index.json");

	// 更新 src/preprocess/presetIndex.ts 中的预设索引
	let srcContent = readFileSync(presetIndexSrcPath, "utf-8");
	for (const [key, cid] of Object.entries(cidMap)) {
		srcContent = srcContent.replace(
			new RegExp(`<CID_${key}>`, "g"),
			cid,
		);
	}
	writeFileSync(presetIndexSrcPath, srcContent, "utf-8");
	console.log("Updated src/preprocess/presetIndex.ts");

	console.log("\nPreset index updated successfully.");
	console.log("Run 'pnpm run build' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
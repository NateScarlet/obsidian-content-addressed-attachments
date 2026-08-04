/**
 * 更新预设索引。
 *
 * 从 dist/presets/ 计算预设脚本的 CID，
 * 更新 pre-process-presets/preset-index.json 和 src/preprocess/preset-index.json 中的 CID 占位符。
 *
 * 用法: node scripts/update-preset-index.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetDistDir = resolve(root, "dist", "presets");
const presetIndexPath = resolve(root, "pre-process-presets", "preset-index.json");
const presetIndexSrcPath = resolve(root, "src", "preprocess", "preset-index.json");

const presets = ["imagemagick.js"];

function computeCID(filePath) {
	const data = readFileSync(filePath);
	return sha256.digest(data).then((digest) =>
		CID.create(1, 0x55, digest).toString(),
	);
}

function updateIndexFile(indexPath, cidMap) {
	let content = readFileSync(indexPath, "utf-8");
	for (const [key, cid] of Object.entries(cidMap)) {
		content = content.replace(new RegExp(`<CID_${key}>`, "g"), cid);
	}
	writeFileSync(indexPath, content, "utf-8");
	console.log(`Updated ${indexPath}`);
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

	// 更新 pre-process-presets/preset-index.json
	updateIndexFile(presetIndexPath, cidMap);

	// 更新 src/preprocess/preset-index.json
	updateIndexFile(presetIndexSrcPath, cidMap);

	console.log("\nPreset index updated successfully.");
	console.log("Run 'pnpm run build' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
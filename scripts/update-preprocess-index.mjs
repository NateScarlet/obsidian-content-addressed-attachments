/**
 * 更新预处理脚本索引。
 *
 * 从 dist/preprocess-scripts/ 计算脚本的 CID，
 * 更新 src/preprocess/script-index.generated.json 中的 CID 占位符。
 *
 * 用法: node scripts/update-preprocess-index.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scriptDistDir = resolve(root, "dist", "preprocess-scripts");
const scriptIndexPath = resolve(root, "src", "preprocess", "script-index.generated.json");

const scripts = ["imagemagick.js"];

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

	for (const script of scripts) {
		const filePath = resolve(scriptDistDir, script);
		const cid = await computeCID(filePath);
		const key = script.replace(".js", "").toUpperCase();
		cidMap[key] = cid;
		console.log(`${script}: ${cid}`);
	}

	// 更新 src/preprocess/script-index.generated.json
	updateIndexFile(scriptIndexPath, cidMap);

	console.log("\nScript index updated successfully.");
	console.log("Run 'pnpm run build' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
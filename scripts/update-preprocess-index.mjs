/**
 * 更新预处理脚本索引。
 *
 * 从 dist/preprocess-scripts/ 计算脚本的 CID，
 * 更新 src/preprocess/script-index.generated.json 中的 CID 占位符，
 * 并将 preprocess-scripts/community-registry.json 中的社区条目合并进索引。
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
const communityRegistryPath = resolve(root, "preprocess-scripts", "community-registry.json");

const scripts = ["imagemagick.js"];

async function computeCID(filePath) {
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

/** 去除 fragment 参数，得到基础 URL */
function baseURL(scriptURL) {
	const hashIndex = scriptURL.indexOf("#");
	return hashIndex >= 0 ? scriptURL.slice(0, hashIndex) : scriptURL;
}

function updateIndexFile(indexPath, cidMap) {
	let content = readFileSync(indexPath, "utf-8");
	for (const [key, cid] of Object.entries(cidMap)) {
		content = content.replace(new RegExp(`<CID_${key}>`, "g"), cid);
	}
	writeFileSync(indexPath, content, "utf-8");
	console.log(`Updated ${indexPath}`);
}

/** 将社区注册表条目合并进生成的索引，按基础 URL 去重 */
function mergeCommunityEntries(indexPath) {
	const communityEntries = JSON.parse(
		readFileSync(communityRegistryPath, "utf-8"),
	);
	const entries = JSON.parse(readFileSync(indexPath, "utf-8"));

	const seen = new Set(entries.map((entry) => baseURL(entry.scriptURL)));
	let added = 0;
	for (const entry of communityEntries) {
		const base = baseURL(entry.scriptURL);
		if (seen.has(base)) {
			console.log(`Skipped duplicate community entry: ${entry.name} (${base})`);
			continue;
		}
		seen.add(base);
		entries.push(entry);
		added++;
		console.log(`Merged community entry: ${entry.name} (${base})`);
	}

	if (added > 0) {
		writeFileSync(indexPath, JSON.stringify(entries, null, "\t") + "\n", "utf-8");
		console.log(`Merged ${added} community entry/entries into ${indexPath}`);
	}
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

	// 合并社区注册表条目
	mergeCommunityEntries(scriptIndexPath);

	console.log("\nScript index updated successfully.");
	console.log("Run 'pnpm run build' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
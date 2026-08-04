/**
 * 发布预设脚本到 IPFS 并记录 CID。
 *
 * 将 dist/presets/ 中的预设脚本发布到 IPFS，
 * 计算每个文件的 CID 并输出到控制台。
 * 这些 CID 将被用于更新 preset-index.json。
 *
 * 依赖：需要 ipfs 客户端（kubo、ipfs-cli 等）在 PATH 中可用。
 * 如果不可用，可以手动计算 CID 并更新 index。
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetDistDir = resolve(root, "dist", "presets");

const presets = ["avif.js", "webp.js"];

/** 检查是否有 ipfs 命令可用 */
function hasIPFS() {
	try {
		execSync("ipfs --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** 计算文件的 CID（使用本地 ipfs 节点或 js 库） */
async function computeCID(filePath) {
	// 使用 multiformats 计算 CID
	const { CID } = await import("multiformats/cid");
	const { sha256 } = await import("multiformats/hashes/sha2");
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

async function main() {
	if (hasIPFS()) {
		console.log("IPFS CLI detected. Publishing to local IPFS node...");
	}

	for (const preset of presets) {
		const filePath = resolve(presetDistDir, preset);
		const cid = await computeCID(filePath);
		console.log(`${preset}: ${cid}`);

		if (hasIPFS()) {
			try {
				const result = execSync(
					`ipfs add "${filePath}" --cid-version 1 --quiet`,
					{ encoding: "utf-8" },
				).trim();
				console.log(`  Published to IPFS: ${result}`);
			} catch (err) {
				console.warn(`  Failed to publish to IPFS: ${err.message}`);
			}
		}
	}

	console.log("\nUpdate preset-index.json with the CIDs above.");
}

main().catch(console.error);
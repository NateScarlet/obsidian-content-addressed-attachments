/**
 * 发布预设脚本到 GitHub Release。
 *
 * 将 dist/presets/ 中的预设脚本和 WASM 文件上传到 GitHub Release，
 * 预设 URL 格式为：
 *   internal.ipfs-locked:<cid>,<download_url>
 *
 * 依赖：需要 gh CLI 可用，且已登录。
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const presetDistDir = resolve(root, "dist", "presets");

const presets = ["imagemagick.js"];
const wasmFiles = ["magick.wasm"];

/** 获取当前仓库的默认标签 */
function getTag() {
	try {
		const tag = execSync(
			'gh release list --json tagName -q ".[0].tagName"',
			{ encoding: "utf-8", cwd: root },
		).trim();
		return tag || "v0.2.0";
	} catch {
		return "v0.2.0";
	}
}

/** 计算文件的 CID */
async function computeCID(filePath) {
	const { CID } = await import("multiformats/cid");
	const { sha256 } = await import("multiformats/hashes/sha2");
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

/** 上传文件到 GitHub Release */
function uploadToRelease(filePath, tag) {
	const filename = filePath.split(/[/\\]/).pop();
	try {
		execSync(
			`gh release upload "${tag}" "${filePath}" --clobber`,
			{ encoding: "utf-8", cwd: root, stdio: "inherit" },
		);
		console.log(`  Uploaded: ${filename}`);
	} catch (err) {
		console.warn(`  Failed to upload ${filename}: ${err.message}`);
	}
}

async function main() {
	const tag = getTag();
	console.log(`Using tag: ${tag}`);

	const cidMap = {};

	for (const preset of presets) {
		const filePath = resolve(presetDistDir, preset);
		const cid = await computeCID(filePath);
		cidMap[preset] = cid;
		console.log(`${preset}: ${cid}`);

		// 上传到 GitHub Release
		uploadToRelease(filePath, tag);
	}

	// 上传 WASM 文件
	for (const wasmFile of wasmFiles) {
		const filePath = resolve(presetDistDir, wasmFile);
		uploadToRelease(filePath, tag);
	}

	console.log("\nPreset URLs:");
	for (const [preset, cid] of Object.entries(cidMap)) {
		const downloadURL = `https://github.com/NateScarlet/obsidian-content-addressed-attachments/releases/download/${tag}/${preset}`;
		console.log(`  internal.ipfs-locked:${cid},${downloadURL}#format=avif&quality=80`);
	}

	console.log("\nUpdate preset-index.json with the CIDs above.");
}

main().catch(console.error);
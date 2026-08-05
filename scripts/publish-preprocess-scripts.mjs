/**
 * 发布预处理脚本到 GitHub Release。
 *
 * 将 dist/preprocess-scripts/ 中的脚本和 WASM 文件上传到 GitHub Release，
 * 脚本 URL 格式为：
 *   internal.ipfs-locked:<cid>,<download_url>
 *
 * 用法：node scripts/publish-preprocess-scripts.mjs <tag>
 *   tag: GitHub Release 标签名（必填，由 workflow 传入）
 *
 * 依赖：需要 gh CLI 可用，且已登录。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scriptDistDir = resolve(root, "dist", "preprocess-scripts");

const tag = process.argv[2];
if (!tag) {
	console.error("Usage: node scripts/publish-preprocess-scripts.mjs <tag>");
	console.error("  tag: GitHub Release tag name (e.g. v0.3.0)");
	process.exit(1);
}

/** 获取目录下所有文件（递归） */
function getFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const fullPath = resolve(dir, name);
		if (statSync(fullPath).isDirectory()) {
			files.push(...getFiles(fullPath));
		} else {
			files.push(fullPath);
		}
	}
	return files;
}

/** 计算文件的 CID */
async function computeCID(filePath: string): Promise<string> {
	const data = readFileSync(filePath);
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

/** 上传文件到 GitHub Release */
function uploadToRelease(filePath: string, tag: string): void {
	const filename = filePath.split(/[/\\]/).pop();
	try {
		execSync(
			`gh release upload "${tag}" "${filePath}" --clobber`,
			{ encoding: "utf-8", cwd: root, stdio: "inherit" },
		);
		console.log(`  Uploaded: ${filename}`);
	} catch (err) {
		console.error(`  Failed to upload ${filename}: ${(err as Error).message}`);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	if (!existsSync(scriptDistDir)) {
		console.error(`Script dist directory not found: ${scriptDistDir}`);
		console.error("Run `pnpm run preprocess:build` first.");
		process.exit(1);
	}

	console.log(`Using tag: ${tag}`);

	const files = getFiles(scriptDistDir);
	const cidMap: Record<string, string> = {};

	for (const filePath of files) {
		const filename = filePath.split(/[/\\]/).pop();
		const cid = await computeCID(filePath);
		cidMap[filename] = cid;
		console.log(`${filename}: ${cid}`);

		uploadToRelease(filePath, tag);
	}

	console.log("\nScript URLs:");
	for (const [filename, cid] of Object.entries(cidMap)) {
		const downloadURL = `https://github.com/NateScarlet/obsidian-content-addressed-attachments/releases/download/${tag}/${filename}`;
		console.log(`  internal.ipfs-locked:${cid},${downloadURL}`);
	}

	console.log("\nUpdate script URL in plugin settings with the URL above.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
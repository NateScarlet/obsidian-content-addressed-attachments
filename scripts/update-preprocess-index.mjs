/**
 * 更新预处理脚本索引。
 *
 * 从 dist/preprocess-scripts/ 读取 per-script 清单文件，
 * 替换其中 HTTPS URL 的 <TAG> 占位符为实际 release tag。
 * 如果指定了 release tag，将 script-index.generated.json 中的 vault-relative 路径
 * 替换为 internal.ipfs-locked:<cid>,<release asset URL> 格式。
 *
 * 用法:
 *   node scripts/update-preprocess-index.mjs              # 仅替换清单中的 <TAG>
 *   node scripts/update-preprocess-index.mjs <tag>        # 替换 <TAG> 并生成 release 索引
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scriptDistDir = resolve(root, "dist", "preprocess-scripts");
const scriptIndexPath = resolve(root, "src", "preprocess", "script-index.generated.json");
const registryPath = resolve(root, "preprocess-scripts", "registry.json");

/** release asset 下载 URL 模板 */
const RELEASE_ASSET_URL =
	"https://github.com/NateScarlet/obsidian-content-addressed-attachments/releases/download/";

/** 计算文件的 CID (v1, raw codec, SHA-256) */
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

async function main() {
	// pnpm run -- <tag> 会传递 "--" 作为第一个参数，需要跳过
	const releaseTag = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

	// 查找所有 per-script 清单文件
	const manifestNames = readdirSync(scriptDistDir).filter(
		(name) => name.endsWith(".json") && name !== ".cid-map.json",
	);

	const manifestPaths = manifestNames.map((name) =>
		resolve(scriptDistDir, name),
	);

	if (manifestPaths.length === 0) {
		console.error("No manifest files found in dist/preprocess-scripts/.");
		process.exit(1);
	}

	// 替换清单中 HTTPS URL 的 <TAG> 占位符
	for (const manifestPath of manifestPaths) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		let changed = false;

		for (const [filename, fileSource] of Object.entries(manifest.files)) {
			if (fileSource.sources) {
				const updatedSources = fileSource.sources.map((source) => {
					if (source.includes("<TAG>")) {
						changed = true;
						if (releaseTag) {
							return source.replace(/<TAG>/g, releaseTag);
						}
						// 无 release tag 时保留 <TAG> 占位符
						return source;
					}
					return source;
				});
				fileSource.sources = updatedSources;
			}
		}

		if (changed) {
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
			console.log(`Updated <TAG> in ${manifestPath}${releaseTag ? ` -> ${releaseTag}` : ""}`);
		}
	}

	if (!releaseTag) {
		console.log("\nNo release tag specified. Skipping release index update.");
		console.log("Run 'pnpm run preprocess:update-index <tag>' to update the release index.");
		return;
	}

	// 从 registry.json 读取所有预设条目，将 Vault 相对路径重写为 internal.ipfs-locked: 发布格式
	const releaseAssetBase = `${RELEASE_ASSET_URL}${releaseTag}/`;
	const entries = existsSync(registryPath)
		? JSON.parse(readFileSync(registryPath, "utf-8"))
		: [];

	const updatedEntries = [];
	for (const entry of entries) {
		const base = baseURL(entry.scriptURL);
		const hashIndex = entry.scriptURL.indexOf("#");
		const fragment = hashIndex >= 0 ? entry.scriptURL.slice(hashIndex) : "";

		// 非 vault-relative 路径（如社区已 Pin 的 internal.ipfs-locked: 脚本），保持原样
		if (!base.includes("preprocess-scripts") || base.startsWith("internal.ipfs-locked:")) {
			updatedEntries.push(entry);
			continue;
		}

		// 从 vault-relative 路径推导脚本文件名，再映射到清单文件名
		const scriptFilename = base.split("/").pop();
		const manifestName = scriptFilename ? scriptFilename.replace(/\.js$/, ".json") : null;
		if (!manifestName) {
			console.warn(`Cannot determine manifest name for ${entry.name}, skipping.`);
			updatedEntries.push(entry);
			continue;
		}

		const manifestPath = resolve(scriptDistDir, manifestName);
		if (!existsSync(manifestPath)) {
			console.warn(`Manifest not found: ${manifestPath}, skipping entry: ${entry.name}`);
			updatedEntries.push(entry);
			continue;
		}

		// 计算清单文件自身的 CID
		const manifestCID = await computeCID(manifestPath);
		const releaseAssetURL = `${releaseAssetBase}${manifestName}`;
		const newScriptURL = `internal.ipfs-locked:${manifestCID},${releaseAssetURL}${fragment}`;

		console.log(`  ${entry.name}: ${entry.scriptURL} -> ${newScriptURL}`);

		updatedEntries.push({
			...entry,
			scriptURL: newScriptURL,
		});
	}

	writeFileSync(scriptIndexPath, JSON.stringify(updatedEntries, null, "\t") + "\n", "utf-8");
	console.log(`\nUpdated ${scriptIndexPath} for release`);

	console.log("\nScript index updated successfully for release.");
	console.log("Run 'pnpm run build:esbuild production' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
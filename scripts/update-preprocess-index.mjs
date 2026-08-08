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
const communityRegistryPath = resolve(root, "preprocess-scripts", "community-registry.json");

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

/** 将社区注册表条目合并进生成的索引，按基础 URL 去重，并将 HTTP(S) URL 锁定为 internal.ipfs-locked: 格式 */
async function mergeCommunityEntries(indexPath) {
	if (!existsSync(communityRegistryPath)) {
		console.log("No community registry found, skipping merge.");
		return;
	}
	const communityEntries = JSON.parse(readFileSync(communityRegistryPath, "utf-8"));
	if (communityEntries.length === 0) {
		console.log("Community registry is empty, skipping merge.");
		return;
	}

	const entries = JSON.parse(readFileSync(indexPath, "utf-8"));
	const seen = new Set(entries.map((entry) => baseURL(entry.scriptURL)));
	let added = 0;
	for (const entry of communityEntries) {
		const base = baseURL(entry.scriptURL);
		if (seen.has(base)) {
			console.log(`Skipped duplicate community entry: ${entry.name} (${base})`);
			continue;
		}

		let scriptURL = entry.scriptURL;
		if (base.startsWith("http://") || base.startsWith("https://")) {
			console.log(`Pinning community script ${entry.name} from ${base}...`);
			const hashIndex = entry.scriptURL.indexOf("#");
			const fragment = hashIndex >= 0 ? entry.scriptURL.slice(hashIndex) : "";

			const resp = await fetch(base);
			if (!resp.ok) {
				console.error(`Failed to fetch community script from ${base}: ${resp.status} ${resp.statusText}`);
				process.exit(1);
			}
			const buffer = await resp.arrayBuffer();
			const digest = await sha256.digest(new Uint8Array(buffer));
			const cid = CID.create(1, 0x55, digest).toString();
			scriptURL = `internal.ipfs-locked:${cid},${base}${fragment}`;
			console.log(`  Pinned ${entry.name} -> ${scriptURL}`);
		} else if (!base.startsWith("internal.ipfs-locked:")) {
			console.warn(`Warning: Community entry ${entry.name} scriptURL is not HTTP(S) or internal.ipfs-locked: format`);
		}

		seen.add(baseURL(scriptURL));
		entries.push({
			...entry,
			scriptURL,
		});
		added++;
		console.log(`Merged community entry: ${entry.name}`);
	}

	if (added > 0) {
		writeFileSync(indexPath, JSON.stringify(entries, null, "\t") + "\n", "utf-8");
		console.log(`Merged ${added} community entry/entries into ${indexPath}`);
	}
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

	// 生成 internal.ipfs-locked: 格式的索引条目
	const releaseAssetBase = `${RELEASE_ASSET_URL}${releaseTag}/`;
	const entries = JSON.parse(readFileSync(scriptIndexPath, "utf-8"));

	const updatedEntries = [];
	for (const entry of entries) {
		const base = baseURL(entry.scriptURL);
		const hashIndex = entry.scriptURL.indexOf("#");
		const fragment = hashIndex >= 0 ? entry.scriptURL.slice(hashIndex) : "";

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
	console.log(`\nUpdated ${scriptIndexPath} with internal.ipfs-locked: format`);

	// 合并社区注册表条目（包含 CID 内容锁定与 Pin 校验）
	await mergeCommunityEntries(scriptIndexPath);

	console.log("\nScript index updated successfully for release.");
	console.log("Run 'pnpm run build:esbuild production' to rebuild the plugin with the updated index.");
}

main().catch(console.error);
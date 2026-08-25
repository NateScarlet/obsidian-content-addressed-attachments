/**
 * 更新预处理脚本索引（生成 src/preprocess/script-index.generated.json）。
 *
 * 职责：
 * 1. 替换 dist/preprocess-scripts/ 清单中 HTTPS URL 的 <TAG> 占位符为实际 release tag
 * 2. 从 preprocess-scripts/registry.json 读取预设条目，将本地相对路径重写为
 *    internal.ipfs-locked:<cid>,<release asset URL> 格式，写入 script-index.generated.json
 * 3. 已 Pin 的社区条目（internal.ipfs-locked:）保持原样
 *
 * 用法:
 *   node scripts/generate-preprocess-index.mjs              # 仅替换清单中的 <TAG>
 *   node scripts/generate-preprocess-index.mjs <tag>        # 替换 <TAG> 并生成 release 索引
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
	RELEASE_ASSET_BASE_URL,
	baseURL,
	computeCID,
	releaseAssetName,
} from "./preprocess-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scriptDistDir = resolve(root, "dist", "preprocess-scripts");
const scriptIndexPath = resolve(root, "src", "preprocess", "script-index.generated.json");
const registryPath = resolve(root, "preprocess-scripts", "registry.json");

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
		// 开发模式：注册表条目原样写入生成索引（保留 vault-relative URL），保证本地构建可用
		const devEntries = existsSync(registryPath)
			? JSON.parse(readFileSync(registryPath, "utf-8"))
			: [];
		writeFileSync(
			scriptIndexPath,
			JSON.stringify(devEntries, null, "\t") + "\n",
			"utf-8",
		);
		console.log(`\nUpdated ${scriptIndexPath} from registry (dev mode, vault-relative URLs).`);
		console.log("Run 'pnpm run preprocess:generate-index <tag>' to generate the release index.");
		return;
	}

	// 从 registry.json 读取所有预设条目，将 Vault 相对路径重写为 internal.ipfs-locked: 发布格式
	const releaseAssetBase = `${RELEASE_ASSET_BASE_URL}${releaseTag}/`;
	const entries = existsSync(registryPath)
		? JSON.parse(readFileSync(registryPath, "utf-8"))
		: [];

	const updatedEntries = [];
	for (const entry of entries) {
		const base = baseURL(entry.scriptURL);
		const hashIndex = entry.scriptURL.indexOf("#");
		const fragment = hashIndex >= 0 ? entry.scriptURL.slice(hashIndex) : "";

		// 有协议头的（internal.ipfs-locked:、https: 等）不是 vault-relative 路径，保持原样
		const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base);
		if (hasProtocol) {
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
		const releaseAssetURL = `${releaseAssetBase}${releaseAssetName(manifestName)}`;
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

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
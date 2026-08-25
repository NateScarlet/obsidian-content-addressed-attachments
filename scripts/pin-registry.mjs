/**
 * 为 preprocess-scripts/registry.json 中的 HTTP(S) URL 生成 CID 内容锁定。
 *
 * 维护者在接受 PR 时运行此脚本，将未锁定的 HTTP(S) URL 转换为 internal.ipfs-locked:<cid>,<url> 格式，
 * 确保写入仓库的条目具有绝对防篡改性。
 *
 * 用法:
 *   node scripts/pin-registry.mjs
 *   pnpm run preprocess:pin-registry
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
	baseURL,
	computeDataCID,
} from "./preprocess-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const registryPath = resolve(
	root,
	"preprocess-scripts",
	"registry.json",
);

async function pinRegistry() {
	if (!existsSync(registryPath)) {
		console.log("No registry found.");
		return;
	}

	const registryEntries = JSON.parse(
		readFileSync(registryPath, "utf-8"),
	);
	let updatedCount = 0;

	for (const entry of registryEntries) {
		const base = baseURL(entry.scriptURL);
		if (base.startsWith("http://") || base.startsWith("https://")) {
			console.log(`Pinning script '${entry.name}' from ${base}...`);
			const hashIndex = entry.scriptURL.indexOf("#");
			const fragment = hashIndex >= 0 ? entry.scriptURL.slice(hashIndex) : "";

			const resp = await fetch(base);
			if (!resp.ok) {
				console.error(
					`Failed to fetch script from ${base}: ${resp.status} ${resp.statusText}`,
				);
				process.exit(1);
			}

			const buffer = await resp.arrayBuffer();
			const cid = await computeDataCID(new Uint8Array(buffer));
			const pinnedURL = `internal.ipfs-locked:${cid},${base}${fragment}`;

			console.log(
				`  Pinned '${entry.name}':\n    Before: ${entry.scriptURL}\n    After:  ${pinnedURL}`,
			);
			entry.scriptURL = pinnedURL;
			updatedCount++;
		}
	}

	if (updatedCount > 0) {
		writeFileSync(
			registryPath,
			JSON.stringify(registryEntries, null, 2) + "\n",
			"utf-8",
		);
		console.log(
			`\nSuccessfully pinned ${updatedCount} entry/entries in ${registryPath}`,
		);
	} else {
		console.log(
			"All registry entries are already pinned with internal.ipfs-locked: URLs or vault-relative paths.",
		);
	}
}

pinRegistry().catch((err) => {
	console.error(err);
	process.exit(1);
});

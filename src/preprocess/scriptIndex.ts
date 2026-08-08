import scriptIndexJson from "./script-index.generated.json";
import type { ScriptIndexEntry } from "./types";

/**
 * 脚本索引，直接从 JSON 文件导入。
 * 在发布流程中，scripts/generate-preprocess-index.mjs 会更新 JSON 中的 CID。
 */
export const SCRIPT_INDEX: ScriptIndexEntry[] = scriptIndexJson;

/**
 * 根据 scriptURL 在脚本索引中查找对应的条目。
 */
export function findScriptByURL(
	scriptURL: string,
): ScriptIndexEntry | undefined {
	// 去除 fragment 参数后比较
	const hashIndex = scriptURL.indexOf("#");
	const baseURL = hashIndex >= 0 ? scriptURL.slice(0, hashIndex) : scriptURL;

	return SCRIPT_INDEX.find((entry) => {
		const entryHashIndex = entry.scriptURL.indexOf("#");
		const entryBase =
			entryHashIndex >= 0
				? entry.scriptURL.slice(0, entryHashIndex)
				: entry.scriptURL;
		return entryBase === baseURL;
	});
}

/**
 * 获取脚本索引中所有条目的基础 URL 集合（不含 fragment）。
 */
export function getIndexedScriptURLs(): Set<string> {
	const urls = new Set<string>();
	for (const entry of SCRIPT_INDEX) {
		const hashIndex = entry.scriptURL.indexOf("#");
		const base =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		urls.add(base);
	}
	return urls;
}

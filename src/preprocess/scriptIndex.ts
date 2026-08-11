import scriptIndexJson from "./script-index.generated.json";
import type { ScriptIndexEntry } from "./types";
import { stripFragment } from "./stripFragment";

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
	const baseURL = stripFragment(scriptURL);

	return SCRIPT_INDEX.find((entry) => {
		return stripFragment(entry.scriptURL) === baseURL;
	});
}

/**
 * 获取脚本索引中所有条目的基础 URL 集合（不含 fragment）。
 */
export function getIndexedScriptURLs(): Set<string> {
	const urls = new Set<string>();
	for (const entry of SCRIPT_INDEX) {
		urls.add(stripFragment(entry.scriptURL));
	}
	return urls;
}

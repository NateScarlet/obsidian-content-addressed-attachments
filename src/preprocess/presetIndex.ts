import presetIndexJson from "./preset-index.json";
import type { PresetEntry } from "./types";

/**
 * 预设索引，直接从 JSON 文件导入。
 * 在发布流程中，scripts/update-preset-index.mjs 会更新 JSON 中的 CID。
 */
export const PRESET_INDEX: PresetEntry[] = presetIndexJson;

/**
 * 根据 scriptURL 在预设索引中查找对应的条目。
 */
export function findPresetByURL(scriptURL: string): PresetEntry | undefined {
	// 去除 fragment 参数后比较
	const hashIndex = scriptURL.indexOf("#");
	const baseURL = hashIndex >= 0 ? scriptURL.slice(0, hashIndex) : scriptURL;

	return PRESET_INDEX.find((entry) => {
		const entryHashIndex = entry.scriptURL.indexOf("#");
		const entryBase =
			entryHashIndex >= 0
				? entry.scriptURL.slice(0, entryHashIndex)
				: entry.scriptURL;
		return entryBase === baseURL;
	});
}

/**
 * 获取预设索引中所有条目的基础 URL 集合（不含 fragment）。
 */
export function getPresetBaseURLs(): Set<string> {
	const urls = new Set<string>();
	for (const entry of PRESET_INDEX) {
		const hashIndex = entry.scriptURL.indexOf("#");
		const base =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		urls.add(base);
	}
	return urls;
}

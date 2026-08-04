import type { PresetEntry } from "./types";

// 预设索引在构建时生成，CID 由发布管线填充
// 开发阶段使用占位符，发布前由脚本替换

export const PRESET_INDEX: PresetEntry[] = [
	{
		name: "AVIF",
		description: "Convert images to AVIF format for better compression",
		scriptURL: "internal.ipfs-locked:<CID_AVIF>,https://example.com/presets/avif.js#format=avif&quality=80",
	},
	{
		name: "WebP",
		description: "Convert images to WebP format for better compression",
		scriptURL: "internal.ipfs-locked:<CID_WEBP>,https://example.com/presets/webp.js#format=webp&quality=80",
	},
];

/**
 * 根据 scriptURL 在预设索引中查找对应的条目。
 */
export function findPresetByURL(
	scriptURL: string,
): PresetEntry | undefined {
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
		const base = hashIndex >= 0 ? entry.scriptURL.slice(0, hashIndex) : entry.scriptURL;
		urls.add(base);
	}
	return urls;
}
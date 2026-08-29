import type { HeaderRule } from "../URLResolver";

/**
 * 将 URL 匹配的 header 规则合并进 headers。
 * 空 baseUrl 视为未配置，避免误匹配所有请求。
 */
export function applyHeaderRules(
	url: string,
	headers: Headers,
	rules: HeaderRule[],
): void {
	for (const rule of rules) {
		if (!rule.baseUrl) continue;
		if (!url.startsWith(rule.baseUrl)) continue;
		for (const [key, value] of rule.headers) {
			headers.set(key, value);
		}
	}
}

/** 将 Headers 转换为 requestUrl 接受的 Record 形式 */
export function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

import type { HeaderRule } from "../URLResolver";
import renderHeaderValue, { type SecretReader } from "./renderHeaderValue";

/**
 * 将 URL 匹配的 header 规则合并进 headers，并渲染值中的 secret 占位符。
 * 空 baseUrl 视为未配置，避免误匹配所有请求。
 */
export async function applyHeaderRules(
	url: string,
	headers: Headers,
	rules: HeaderRule[],
	readSecret: SecretReader,
): Promise<void> {
	for (const rule of rules) {
		if (!rule.baseUrl) continue;
		if (!url.startsWith(rule.baseUrl)) continue;
		for (const [key, value] of rule.headers) {
			headers.set(key, await renderHeaderValue(value, readSecret));
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

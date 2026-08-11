/** 去除 URL 的 fragment 参数，返回基础 URL */
export function stripFragment(url: string): string {
	const hashIndex = url.indexOf("#");
	return hashIndex >= 0 ? url.slice(0, hashIndex) : url;
}

/**
 * Obsidian Base 卡片封面背景图的伪装前缀 URL 处理。
 *
 * Base 卡片视图的封面属性只接受 http(s) URL 或本地附件链接（见官方文档），
 * 会直接丢弃 ipfs:// / internal.ipfs-locked: 值。为让封面能展示 IPFS 内容，
 * 用 http:/// 前缀包装原始链接（如 http:///ipfs://<cid>）使其通过 Obsidian
 * 的前缀检查并原样保留在 DOM 的 background-image 中；本模块负责剥离伪装前缀
 * 还原规范链接，以及把解析结果格式化为 background-image 值。
 */

/**
 * 从 background-image 的 CSS 值中提取伪装前缀后的规范 IPFS 链接。
 * 非 Base 封面（普通 http(s) 背景图）或无法识别时返回 undefined。
 */
export function extractWrappedBackgroundURL(
	backgroundImage: string,
): string | undefined {
	const urlMatch = backgroundImage.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
	const wrapped = urlMatch?.[1]?.trim();
	if (!wrapped?.startsWith("http:///")) {
		return undefined;
	}
	const canonical = wrapped.slice("http:///".length);
	if (
		canonical.startsWith("ipfs://") ||
		canonical.startsWith("internal.ipfs-locked:")
	) {
		return canonical;
	}
	return undefined;
}

/** 把解析后的资源 URL 格式化为 background-image 值。 */
export function formatBackgroundImage(url: string): string {
	return `url("${url}")`;
}

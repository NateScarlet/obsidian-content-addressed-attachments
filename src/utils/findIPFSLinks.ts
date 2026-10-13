import IPFSLink from "./IPFSLink";
import parseIPFSLockedURL, { type IPFSLockedURL } from "./parseIPFSLockedURL";

export type IPFSLinkMatch = {
	pos: [startIndex: number, endIndex: number];
	url: NonNullable<
		(IPFSLink | IPFSLockedURL) & Partial<IPFSLink> & Partial<IPFSLockedURL>
	>;
	isEmbed: boolean;
	title?: string;
};

/** 包裹锁定链接的成对定界符：前置定界符 -> 对应的闭合字符 */
const LOCKED_URL_DELIMITERS: Record<string, string> = {
	'"': '"',
	"'": "'",
	"`": "`",
	"(": ")",
	"<": ">",
};

/**
 * 计算锁定链接的结束位置（不含）。
 *
 * 正则只能按「非空白且非 `)`」贪婪匹配，遇到 JSON 之类的结构时会把闭合定界符
 * 及其后的文本一起吞入，导致解析出的文件名被污染。因此紧邻链接的前一个字符是
 * 成对定界符时，链接延伸到对应闭合字符之前；否则沿用正则的边界。
 *
 * 配对搜索同样以正则边界为上界：否则空白之后的文本会被并入链接，URL 解析时
 * 把空白百分号编码进 pathname，得到比污染前更长的文件名。
 *
 * 已知取舍：链接自身含有与定界符同种的字符时，会在第一个该字符处截断。
 */
function findLockedURLEnd(
	markdown: string,
	urlStartIndex: number,
	matchedURL: string,
): number {
	const regexEndIndex = urlStartIndex + matchedURL.length;
	const closing = LOCKED_URL_DELIMITERS[markdown[urlStartIndex - 1]];
	if (!closing) return regexEndIndex;
	const closingIndex = markdown.indexOf(closing, urlStartIndex);
	// 定界符没有配对时无法判断边界，退回正则的边界
	return closingIndex < 0
		? regexEndIndex
		: Math.min(closingIndex, regexEndIndex);
}

export default function* findIPFSLinks(
	markdown: string,
): IterableIterator<IPFSLinkMatch> {
	// 匹配任何 IPFS base32 链接，包含新增的 internal.ipfs-locked 链接
	const pattern = new RegExp(
		"\\s*(" +
			"(?:" +
			"ipfs://" +
			"(b[a-z2-7]{58})" + // base32 CID
			"(/[-\\w$.+!*',;:@&=%]*)?" + // 路径
			"(\\?[-\\w$.+!*',;:@&=/?%]*)?" + // 查询参数
			"(#[" +
			"-\\w$.+!*',;:@&=/?%]*)?" + // 片段
			"|" +
			"internal\\.ipfs-locked:b[a-z2-7]{58},[^\\s)]+" + // internal.ipfs-locked 链接
			")" +
			")\\s*",
		"g",
	);

	let match: RegExpExecArray | null;

	while ((match = pattern.exec(markdown)) !== null) {
		const [fullMatch, matchedURL] = match;
		const startIndex = match.index;
		const endIndex = startIndex + fullMatch.length;

		// 计算链接在原始字符串中的开始位置
		const rawURLStartIndex = startIndex + fullMatch.indexOf(matchedURL);

		// 根据链接类型使用不同的解析函数
		let url;
		let rawURL = matchedURL;
		if (rawURL.startsWith("internal.ipfs-locked:")) {
			rawURL = markdown.slice(
				rawURLStartIndex,
				findLockedURLEnd(markdown, rawURLStartIndex, matchedURL),
			);
			// 正则的贪婪匹配会吞掉紧邻的下一个链接，收窄后从链接结尾继续扫描
			pattern.lastIndex = rawURLStartIndex + rawURL.length;
			url = parseIPFSLockedURL(rawURL);
		} else {
			url = IPFSLink.parse(rawURL);
		}

		if (!url) continue;

		// 检查链接前后是否有括号（Markdown链接语法）
		const before =
			startIndex > 2 ? markdown.slice(startIndex - 2, startIndex) : "";
		const after = endIndex < markdown.length ? markdown[endIndex] : "";

		let title: string | undefined;
		let isEmbed = false;

		// 如果被括号包裹，并且前面是 `](`，则是 Markdown 链接
		if (before === "](" && after === ")") {
			// 向前查找标题部分 [title]
			let bracketStart = -1;

			// 从 `]` 的位置向前搜索第一个非转义的 `[`
			for (let i = startIndex - 3; i >= 0; i--) {
				const char = markdown[i];

				// 遇到换行符就停止
				if (char === "\n") break;

				// 找到 `[`，检查是否被转义
				if (char === "[") {
					// 检查前面的字符是否是转义符 `\`
					if (i > 0 && markdown[i - 1] === "\\") {
						// 被转义了，继续搜索
						continue;
					}
					bracketStart = i;
					break;
				}
			}

			// 如果找到了 `[`，提取标题和是否为嵌入
			if (bracketStart !== -1) {
				title =
					markdown
						.substring(bracketStart + 1, startIndex - 2)
						.trim()
						.replaceAll("\\[", "[") || undefined;
				// 处理图片尺寸语法
				const titleMatch = title?.match(/^(.+)\|\d+$/);
				if (titleMatch) {
					title = titleMatch[1];
				}

				if (bracketStart > 0 && markdown[bracketStart - 1] === "!") {
					isEmbed = true;
				}
			}
		}

		yield {
			pos: [rawURLStartIndex, rawURLStartIndex + rawURL.length],
			url,
			isEmbed,
			title,
		};
	}
}

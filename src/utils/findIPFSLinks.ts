import parseIPFSLink from "./parseIPFSLink";

export default function* findIPFSLinks(markdown: string): IterableIterator<{
	pos: [startIndex: number, endIndex: number];
	url: NonNullable<ReturnType<typeof parseIPFSLink>>;
	title?: string;
}> {
	// 匹配任何 IPFS base32 链接，不支持含括号的链接，因为和 Markdown 链接语法冲突
	const pattern = new RegExp(
		"\\s*(" +
			"ipfs://" +
			"(b[a-z2-7]{58})" + // base32 CID
			"(/[-\\w$.+!*',;:@&=%]*)?" + // 路径
			"(\\?[-\\w$.+!*',;:@&=/?%]*)?" + // 查询参数
			"(#[-\\w$.+!*',;:@&=/?%]*)?" + // 片段
			")\\s*",
		"g",
	);

	let match: RegExpExecArray | null;

	while ((match = pattern.exec(markdown)) !== null) {
		const [fullMatch, rawURL] = match;
		const startIndex = match.index;
		const endIndex = startIndex + fullMatch.length;
		const rawURLStartIndex = startIndex + fullMatch.indexOf("ipfs://");

		// 解析IPFS链接
		const url = parseIPFSLink(rawURL);
		if (!url) continue;

		// 检查链接前后是否有括号（Markdown链接语法）
		const before =
			startIndex > 2 ? markdown.slice(startIndex - 2, startIndex) : "";
		const after = endIndex < markdown.length ? markdown[endIndex] : "";

		let title: string | undefined;

		// 如果被括号包裹，并且前面是`](`，则是Markdown链接
		if (before === "](" && after === ")") {
			// 向前查找标题部分 [title]
			let bracketStart = -1;

			// 从`]`的位置向前搜索第一个非转义的`[`
			for (let i = startIndex - 3; i >= 0; i--) {
				const char = markdown[i];

				// 遇到换行符就停止
				if (char === "\n") break;

				// 找到`[`，检查是否被转义
				if (char === "[") {
					// 检查前面的字符是否是转义符`\`
					if (i > 0 && markdown[i - 1] === "\\") {
						// 被转义了，继续搜索
						continue;
					}
					bracketStart = i;
					break;
				}
			}

			// 如果找到了`[`，提取标题
			if (bracketStart !== -1) {
				title =
					markdown
						.substring(bracketStart + 1, startIndex - 2)
						.trim()
						.replaceAll("\\[", "[") || undefined;
				// 处理图片尺寸语法
				const match = title?.match(/^(.+)\|\d+$/);
				if (match) {
					title = match[1];
				}
			}
		}

		yield {
			pos: [rawURLStartIndex, rawURLStartIndex + rawURL.length],
			url,
			title,
		};
	}
}

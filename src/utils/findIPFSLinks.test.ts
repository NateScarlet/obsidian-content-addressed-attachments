import { describe, it, expect } from "vitest";
import findIPFSLinks, { type IPFSLinkMatch } from "./findIPFSLinks";

describe("findIPFSLinks", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";

	it("correctly identifies image embed Markdown syntax and pos", () => {
		const rawUrl = `ipfs://${validCIDString}?filename=photo.png&format=image%2Fpng`;
		const markdown = `Text before ![photo.png](${rawUrl}) text after`;

		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const match = matches[0];
		expect(match.isEmbed).toBe(true);
		expect(match.title).toBe("photo.png");

		// pos should be raw URL range
		const rawText = markdown.slice(match.pos[0], match.pos[1]);
		expect(rawText).toBe(rawUrl);
	});

	it("correctly identifies standard link Markdown syntax and pos", () => {
		const rawUrl = `ipfs://${validCIDString}?filename=document.pdf&format=application%2Fpdf`;
		const markdown = `Text before [document.pdf](${rawUrl}) text after`;

		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const match = matches[0];
		expect(match.isEmbed).toBe(false);
		expect(match.title).toBe("document.pdf");
	});

	it("correctly handles bare raw IPFS URLs without Markdown brackets", () => {
		const rawUrl = `ipfs://${validCIDString}`;
		const markdown = `Check out ${rawUrl} link`;

		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const match = matches[0];
		expect(match.isEmbed).toBe(false);
		expect(markdown.slice(match.pos[0], match.pos[1])).toBe(rawUrl);
	});
});

describe("findIPFSLinks 锁定链接的结束边界", () => {
	const lockedCID =
		"bafkreidcmdbuhaxw4aumlrfpogomdgxfazxpqi3coivsnaz6dpkdx73joa";
	const lockedSourceURL =
		"https://i.pximg.net/img-master/img/2026/10/06/01/01/36/150507314_p0_master1200.jpg";
	const lockedURL = `internal.ipfs-locked:${lockedCID},${lockedSourceURL}`;
	const lockedFilename = "150507314_p0_master1200.jpg";

	/** 断言整段文本里只匹配到一个链接，且匹配区间恰为 expectedRawURL */
	function expectOnlyLink(
		markdown: string,
		expectedRawURL: string = lockedURL,
	): IPFSLinkMatch {
		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const [match] = matches;
		expect(markdown.slice(match.pos[0], match.pos[1])).toBe(expectedRawURL);
		return match;
	}

	it("不应把 JSON 字符串值闭合引号之后的文本当作链接的一部分", () => {
		const markdown = `<!-- {"v":3,"pages":[{"masterURL":"${lockedURL}"}]} ^artwork -->`;

		const match = expectOnlyLink(markdown);

		expect(match.url.filename).toBe(lockedFilename);
	});

	it.each([
		["双引号", '"', '"'],
		["单引号", "'", "'"],
		["反引号", "`", "`"],
		["圆括号", "(", ")"],
		["尖括号", "<", ">"],
	])("应把 %s 包裹的锁定链接截断到闭合字符之前", (_name, open, close) => {
		const markdown = `Text ${open}${lockedURL}${close} tail`;

		const match = expectOnlyLink(markdown);

		expect(match.url.filename).toBe(lockedFilename);
	});

	it("没有前导定界符时截断到空白", () => {
		const markdown = `See ${lockedURL} for details`;

		expectOnlyLink(markdown);
	});

	it("没有前导定界符时截断到右括号", () => {
		const markdown = `See ${lockedURL}) for details`;

		expectOnlyLink(markdown);
	});

	it("定界符与链接之间有空白时按无前导定界符处理", () => {
		const markdown = `["prefix ${lockedURL} suffix"]`;

		expectOnlyLink(markdown);
	});

	it("配对的闭合定界符在空白之后时不越过空白边界", () => {
		const markdown = `"${lockedURL} 后文 " 更多文本`;

		const match = expectOnlyLink(markdown);

		expect(match.url.filename).toBe(lockedFilename);
	});

	it("没有配对的闭合定界符时按空白边界截断", () => {
		const markdown = `"${lockedURL} 后文`;

		expectOnlyLink(markdown);
	});

	it("链接自身含同种定界符字符时在第一个该字符处截断", () => {
		const sourceURL = "https://example.com/wiki/Vesna_(painting).jpg";
		const markdown = `"internal.ipfs-locked:${lockedCID},${sourceURL}" tail`;

		expectOnlyLink(
			markdown,
			`internal.ipfs-locked:${lockedCID},https://example.com/wiki/Vesna_(painting`,
		);
	});

	it("同一行内相邻的锁定链接都会被识别", () => {
		const markdown = `{"a":"${lockedURL}","b":"${lockedURL}"}`;

		const matches = Array.from(findIPFSLinks(markdown));

		expect(matches).toHaveLength(2);
		for (const match of matches) {
			expect(markdown.slice(match.pos[0], match.pos[1])).toBe(lockedURL);
			expect(match.url.filename).toBe(lockedFilename);
		}
	});

	it("不应改变 ipfs:// 链接的结束边界", () => {
		const rawUrl = `ipfs://${lockedCID}?filename=photo.png&format=image%2Fpng`;
		const markdown = `<!-- {"src":"${rawUrl}"} -->`;

		const match = expectOnlyLink(markdown, rawUrl);

		expect(match.url.filename).toBe("photo.png");
	});
});

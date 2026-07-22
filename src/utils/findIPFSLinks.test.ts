import { describe, it, expect } from "vitest";
import findIPFSLinks from "./findIPFSLinks";

describe("findIPFSLinks", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";

	it("correctly identifies image embed Markdown syntax and fullPos", () => {
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

		// fullPos should include leading ![ and trailing )
		const fullText = markdown.slice(match.fullPos[0], match.fullPos[1]);
		expect(fullText).toBe(`![photo.png](${rawUrl})`);
	});

	it("correctly identifies standard link Markdown syntax and fullPos", () => {
		const rawUrl = `ipfs://${validCIDString}?filename=document.pdf&format=application%2Fpdf`;
		const markdown = `Text before [document.pdf](${rawUrl}) text after`;

		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const match = matches[0];
		expect(match.isEmbed).toBe(false);
		expect(match.title).toBe("document.pdf");

		const fullText = markdown.slice(match.fullPos[0], match.fullPos[1]);
		expect(fullText).toBe(`[document.pdf](${rawUrl})`);
	});

	it("correctly handles bare raw IPFS URLs without Markdown brackets", () => {
		const rawUrl = `ipfs://${validCIDString}`;
		const markdown = `Check out ${rawUrl} link`;

		const matches = Array.from(findIPFSLinks(markdown));
		expect(matches).toHaveLength(1);

		const match = matches[0];
		expect(match.isEmbed).toBe(false);
		expect(match.pos).toEqual(match.fullPos);
	});
});

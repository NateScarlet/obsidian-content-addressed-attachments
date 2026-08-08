import { describe, it, expect } from "vitest";
import {
	createPreprocessPlaceholder,
	replacePlaceholderInContent,
} from "./preprocessPlaceholder";
import findIPFSLinks from "./findIPFSLinks";

describe("preprocessPlaceholder", () => {
	it("generates compact placeholder with timestamp and sequence", () => {
		const res1 = createPreprocessPlaceholder("photo.png");
		const res2 = createPreprocessPlaceholder("photo.png");

		expect(res1.placeholder).toMatch(
			/^%% 正在预处理附件：photo\.png\.\.\. \^prep-[0-9a-z]+-[0-9a-z]+ %%$/,
		);
		expect(res2.placeholder).toMatch(
			/^%% 正在预处理附件：photo\.png\.\.\. \^prep-[0-9a-z]+-[0-9a-z]+ %%$/,
		);
		expect(res1.placeholder).not.toEqual(res2.placeholder);
	});

	it("is ignored by findIPFSLinks", () => {
		const { placeholder } = createPreprocessPlaceholder("test.png");
		const content = `Some text before\n${placeholder}\nSome text after`;
		const links = Array.from(findIPFSLinks(content));
		expect(links).toEqual([]);
	});

	it("replaces exact placeholder in markdown content", () => {
		const { placeholder } = createPreprocessPlaceholder("test.png");
		const content = `# Note\n\nIntro text\n${placeholder}\nOutro text`;
		const replacement = "![test.png](ipfs://bafkreidummy)";

		const updated = replacePlaceholderInContent(
			content,
			placeholder,
			replacement,
		);
		expect(updated).toEqual(
			"# Note\n\nIntro text\n![test.png](ipfs://bafkreidummy)\nOutro text",
		);
	});

	it("replaces placeholder by block ID even if message was slightly modified", () => {
		const { placeholder, id } = createPreprocessPlaceholder("test.png");
		const modifiedPlaceholder = `%% 正在预处理附件：user-modified-title... ^${id} %%`;
		const content = `# Note\n\n${modifiedPlaceholder}\nDone`;
		const replacement = "![test.png](ipfs://bafkreidummy)";

		const updated = replacePlaceholderInContent(
			content,
			placeholder,
			replacement,
		);
		expect(updated).toEqual(
			"# Note\n\n![test.png](ipfs://bafkreidummy)\nDone",
		);
	});
});

import { describe, it, expect, vi } from "vitest";
import type { Editor } from "obsidian";
import {
	createPreprocessPlaceholder,
	replacePlaceholderInContent,
	replacePlaceholderInEditor,
} from "./preprocessPlaceholder";
import findIPFSLinks from "./findIPFSLinks";

function posAt(text: string, offset: number) {
	const before = text.slice(0, offset);
	const lines = before.split("\n");
	return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}

type MockEditor = {
	getValue: () => string;
	setValue: (t: string) => void;
	setCursor: (pos: { line: number; ch: number }) => void;
	offsetToPos: (offset: number) => { line: number; ch: number };
	getText: () => string;
};

function createMockEditor(initialText: string): MockEditor {
	let text = initialText;
	return {
		setValue: vi.fn((t: string) => {
			text = t;
		}),
		getValue: vi.fn(() => text),
		setCursor: vi.fn(),
		offsetToPos: vi.fn((offset: number) => posAt(text, offset)),
		getText: () => text,
	};
}

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

	it("does not touch the editor when placeholder is not present", () => {
		const { placeholder } = createPreprocessPlaceholder("test.png");
		const editor = createMockEditor("# Note\n\nNo placeholder here");

		const replaced = replacePlaceholderInEditor(
			editor as unknown as Editor,
			placeholder,
			"![test.png](ipfs://bafkreidummy)",
		);

		expect(replaced).toBe(false);
		expect(editor.setValue).not.toHaveBeenCalled();
		expect(editor.setCursor).not.toHaveBeenCalled();
	});

	it("keeps cursor at the end of the replaced link instead of resetting to file start", () => {
		const { placeholder } = createPreprocessPlaceholder("test.png");
		const prefix = "# Heading\n\nIntro text\n\n";
		const suffix = "\n\nOutro text";
		const content = `${prefix}${placeholder}${suffix}`;
		const editor = createMockEditor(content);
		const replacement = "![test.png](ipfs://bafkreidummy)";

		const replaced = replacePlaceholderInEditor(
			editor as unknown as Editor,
			placeholder,
			replacement,
		);

		expect(replaced).toBe(true);
		expect(editor.getText()).toBe(`${prefix}${replacement}${suffix}`);
		// 占位符被替换为更长的链接，光标应位于替换后链接的末尾，
		// 而不是被 setValue 重置到文档开头
		const expectedOffset = prefix.length + replacement.length;
		expect(editor.setCursor).toHaveBeenCalledWith(
			posAt(editor.getText(), expectedOffset),
		);
	});
});

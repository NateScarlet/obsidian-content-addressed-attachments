import { describe, it, expect, vi } from "vitest";
import { TFile } from "obsidian";
import {
	createPreprocessPlaceholder,
	replacePlaceholderInContent,
	replacePlaceholderInEditor,
	replacePlaceholderInEditorOrVault,
	type PlaceholderReplaceVault,
} from "./preprocessPlaceholder";
import findIPFSLinks from "./findIPFSLinks";

function posAt(text: string, offset: number) {
	const before = text.slice(0, offset);
	const lines = before.split("\n");
	return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}

type MockEditor = {
	getValue: () => string;
	offsetToPos: (offset: number) => { line: number; ch: number };
	replaceRange: (
		replacement: string,
		from: { line: number; ch: number },
		to?: { line: number; ch: number },
	) => void;
	getText: () => string;
};

function createMockEditor(initialText: string): MockEditor {
	let text = initialText;
	const posToOffset = (pos: { line: number; ch: number }) => {
		const lines = text.split("\n");
		return (
			lines.slice(0, pos.line).reduce((acc, l) => acc + l.length + 1, 0) +
			pos.ch
		);
	};
	return {
		getValue: vi.fn(() => text),
		offsetToPos: vi.fn((offset: number) => posAt(text, offset)),
		replaceRange: vi.fn(
			(
				t: string,
				from: { line: number; ch: number },
				to?: { line: number; ch: number },
			) => {
				const start = posToOffset(from);
				const end = to ? posToOffset(to) : start;
				text = text.slice(0, start) + t + text.slice(end);
			},
		),
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
			editor,
			placeholder,
			"![test.png](ipfs://bafkreidummy)",
		);

		expect(replaced).toBe(false);
		expect(editor.replaceRange).not.toHaveBeenCalled();
	});

	it("replaces the placeholder range via replaceRange, keeping cursor in place", () => {
		const { placeholder } = createPreprocessPlaceholder("test.png");
		const prefix = "# Heading\n\nIntro text\n\n";
		const suffix = "\n\nOutro text";
		const content = `${prefix}${placeholder}${suffix}`;
		const editor = createMockEditor(content);
		const replacement = "![test.png](ipfs://bafkreidummy)";

		const replaced = replacePlaceholderInEditor(
			editor,
			placeholder,
			replacement,
		);

		expect(replaced).toBe(true);
		expect(editor.getText()).toBe(`${prefix}${replacement}${suffix}`);
		// 仅局部替换占位符区间，光标由 CodeMirror 事务保留在替换文本末尾
		expect(editor.replaceRange).toHaveBeenCalledWith(
			replacement,
			posAt(content, prefix.length),
			posAt(content, prefix.length + placeholder.length),
		);
	});
});

describe("replacePlaceholderInEditorOrVault", () => {
	const { placeholder } = createPreprocessPlaceholder("test.png");
	const replacement = "![test.png](ipfs://bafkreidummy)";

	it("replaces in editor when placeholder is still there", async () => {
		const editor = createMockEditor(`# Note\n\n${placeholder}\nEnd`);
		const vault: PlaceholderReplaceVault = {
			getAbstractFileByPath: vi.fn(),
			process: vi.fn(),
		};

		const replaced = await replacePlaceholderInEditorOrVault(
			vault,
			editor,
			"notes/regular.md",
			placeholder,
			replacement,
		);

		expect(replaced).toBe(true);
		expect(editor.getText()).toBe(`# Note\n\n${replacement}\nEnd`);
		expect(vault.getAbstractFileByPath).not.toHaveBeenCalled();
	});

	it("falls back to vault file when editor no longer holds the placeholder", async () => {
		const editor = createMockEditor("# Note\n\nNo placeholder here");
		const file = new TFile();
		file.path = "notes/regular.md";
		const vault: PlaceholderReplaceVault = {
			getAbstractFileByPath: vi.fn().mockReturnValue(file),
			process: vi
				.fn()
				.mockImplementation(
					(_file: TFile, fn: (content: string) => string) =>
						Promise.resolve(fn(`# Note\n\n${placeholder}\nEnd`)),
				),
		};

		const replaced = await replacePlaceholderInEditorOrVault(
			vault,
			editor,
			"notes/regular.md",
			placeholder,
			replacement,
		);

		expect(replaced).toBe(true);
		expect(vault.getAbstractFileByPath).toHaveBeenCalledWith(
			"notes/regular.md",
		);
		expect(vault.process).toHaveBeenCalledWith(file, expect.any(Function));
	});

	it("returns false when placeholder is found in neither editor nor vault", async () => {
		const editor = createMockEditor("# Note\n\nNo placeholder here");
		const file = new TFile();
		file.path = "notes/regular.md";
		const vault: PlaceholderReplaceVault = {
			getAbstractFileByPath: vi.fn().mockReturnValue(file),
			process: vi
				.fn()
				.mockImplementation(
					(_file: TFile, fn: (content: string) => string) =>
						Promise.resolve(fn("# Note\n\nStill nothing")),
				),
		};

		const replaced = await replacePlaceholderInEditorOrVault(
			vault,
			editor,
			"notes/regular.md",
			placeholder,
			replacement,
		);

		expect(replaced).toBe(false);
	});

	it("returns false without touching vault when notePath is empty", async () => {
		const editor = createMockEditor("# Note\n\nNo placeholder here");
		const vault: PlaceholderReplaceVault = {
			getAbstractFileByPath: vi.fn(),
			process: vi.fn(),
		};

		const replaced = await replacePlaceholderInEditorOrVault(
			vault,
			editor,
			"",
			placeholder,
			replacement,
		);

		expect(replaced).toBe(false);
		expect(vault.getAbstractFileByPath).not.toHaveBeenCalled();
		expect(vault.process).not.toHaveBeenCalled();
	});
});

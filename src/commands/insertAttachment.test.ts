import { describe, it, expect, vi } from "vitest";
import { processFileAndInsertLink } from "./insertAttachment";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import type { Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import type { PlaceholderReplaceVault } from "#src/utils/preprocessPlaceholder";

describe("processFileAndInsertLink", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";
	const dummyCID = CID.parse(validCIDString);

	const mockCas = {
		save: vi.fn().mockResolvedValue({ cid: dummyCID }),
	} as unknown as CAS;

	const mockPipelineNoScript = {
		getScriptURL: vi.fn().mockReturnValue(""),
		run: vi.fn().mockResolvedValue(undefined),
	} as unknown as TransformPipeline;

	const mockPipelineWithScript = {
		getScriptURL: vi.fn().mockReturnValue("app://local/script.js"),
		run: vi.fn().mockResolvedValue(undefined),
	} as unknown as TransformPipeline;

	const mockEncryptPathPolicy = {
		ensureEncrypted: vi
			.fn()
			.mockImplementation((file: File, notePath: string) => {
				if (notePath.startsWith("secret/")) {
					return Promise.resolve(
						new File([new Uint8Array(8)], file.name, {
							type: ENCRYPTED_FORMAT,
						}),
					);
				}
				return Promise.resolve(undefined);
			}),
	} as unknown as EncryptPathPolicy;

	function createMockEditor() {
		let text = "";
		const posToOffset = (pos: { line: number; ch: number }) => {
			const lines = text.split("\n");
			return (
				lines
					.slice(0, pos.line)
					.reduce((acc, l) => acc + l.length + 1, 0) + pos.ch
			);
		};
		return {
			replaceSelection: vi.fn((t: string) => {
				text += t;
			}),
			getValue: vi.fn(() => text),
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
			offsetToPos: vi.fn((offset: number) => {
				const before = text.slice(0, offset);
				const lines = before.split("\n");
				return {
					line: lines.length - 1,
					ch: lines[lines.length - 1].length,
				};
			}),
			getText: () => text,
		} as unknown as Editor & { getText: () => string };
	}

	function createMockVault(): PlaceholderReplaceVault {
		return {
			getAbstractFileByPath: vi.fn().mockReturnValue(null),
			process: vi.fn().mockResolvedValue(""),
		};
	}

	it("saves unencrypted attachment directly when preProcess script is not set", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "photo.png", {
			type: "image/png",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			mockPipelineNoScript,
			vault,
		);

		const text = editor.getText();
		expect(text).toContain("![photo.png](ipfs://");
		expect(text).toContain("format=image%2Fpng");
	});

	it("inserts comment placeholder instantly and replaces it async when preProcess script is enabled", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "photo.png", {
			type: "image/png",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			mockPipelineWithScript,
			vault,
		);

		// 检查立即插入的占位符
		const initialText = editor.getText();
		expect(initialText).toMatch(
			/^%% 正在预处理附件：photo\.png\.\.\. \^prep-[0-9a-z]+-[0-9a-z]+ %%$/,
		);

		// 等待后台异步微任务完成
		await new Promise((r) => window.setTimeout(r, 50));

		// 检查占位符是否被替换为最终的 IPFS 链接
		const finalText = editor.getText();
		expect(finalText).toContain("![photo.png](ipfs://");
		expect(finalText).not.toContain("%% 正在预处理");
	});

	it("auto-encrypts pasted/inserted image async when note matches path rule", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "photo.png", {
			type: "image/png",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"secret/confidential.md",
			mockEncryptPathPolicy,
			mockPipelineWithScript,
			vault,
		);

		await new Promise((r) => window.setTimeout(r, 50));

		const text = editor.getText();
		expect(text).toContain("![photo.png](ipfs://");
		expect(text).toContain(
			`format=${encodeURIComponent(ENCRYPTED_FORMAT)}`,
		);
	});

	it("auto-encrypts non-image file without ! embed prefix when note matches path rule", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "doc.pdf", {
			type: "application/pdf",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"secret/confidential.md",
			mockEncryptPathPolicy,
			mockPipelineWithScript,
			vault,
		);

		await new Promise((r) => window.setTimeout(r, 50));

		const text = editor.getText();
		expect(text.startsWith("[doc.pdf](ipfs://")).toBe(true);
		expect(text.startsWith("!")).toBe(false);
	});

	it("handles pasted HEIC file with empty mimeType and formats as embed image when no preProcess script", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "photo.heic", {
			type: "",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			mockPipelineNoScript,
			vault,
		);

		const text = editor.getText();
		expect(text).toContain("![photo.heic](ipfs://");
		expect(text).toContain("format=image%2Fheic");
	});

	it("passes inferred image mimeType to preProcess pipeline for HEIC file with empty mimeType", async () => {
		const editor = createMockEditor();
		const vault = createMockVault();
		const file = new File(["test data"], "photo.heic", {
			type: "",
		});

		const customPipeline = {
			getScriptURL: vi.fn().mockReturnValue("app://local/script.js"),
			run: vi.fn().mockResolvedValue({
				data: new Uint8Array(10),
				filename: "photo.webp",
				mimeType: "image/webp",
			}),
		} as unknown as TransformPipeline;

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			customPipeline,
			vault,
		);

		await new Promise((r) => window.setTimeout(r, 50));

		expect(customPipeline.run).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "photo.heic",
				mimeType: "image/heic",
			}),
		);

		const text = editor.getText();
		expect(text).toContain("![photo.webp](ipfs://");
		expect(text).toContain("format=image%2Fwebp");
	});
});

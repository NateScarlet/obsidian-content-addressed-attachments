import { describe, it, expect, vi } from "vitest";
import { processFileAndInsertLink } from "./insertAttachment";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import type { Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";

/* eslint-disable */
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = globalThis;
}
/* eslint-enable */

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
		return {
			replaceSelection: vi.fn((t: string) => {
				text += t;
			}),
			getValue: vi.fn(() => text),
			setValue: vi.fn((t: string) => {
				text = t;
			}),
			getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
			setCursor: vi.fn(),
			getSelection: vi.fn().mockReturnValue(""),
			getLine: vi.fn().mockReturnValue(""),
			getText: () => text,
		} as unknown as Editor & { getText: () => string };
	}

	it("saves unencrypted attachment directly when preProcess script is not set", async () => {
		const editor = createMockEditor();
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
		);

		const text = editor.getText();
		expect(text).toContain("![photo.png](ipfs://");
		expect(text).toContain("format=image%2Fpng");
	});

	it("inserts comment placeholder instantly and replaces it async when preProcess script is enabled", async () => {
		const editor = createMockEditor();
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
		);

		await new Promise((r) => window.setTimeout(r, 50));

		const text = editor.getText();
		expect(text.startsWith("[doc.pdf](ipfs://")).toBe(true);
		expect(text.startsWith("!")).toBe(false);
	});
});

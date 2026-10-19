import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
	type Mock,
} from "vitest";
import insertAttachment, { processFileAndInsertLink } from "./insertAttachment";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import { TFile, type App, type Editor } from "obsidian";
import { Notice } from "#src/__mocks__/obsidian";
import type { CAS } from "#src/types/CAS";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type TransformPipeline from "#src/preprocess/TransformPipeline";
import type { PlaceholderReplaceVault } from "#src/utils/preprocessPlaceholder";

/** 伪 Editor：额外保留插入文本以便测试断言 */
type MockEditor = Editor & {
	getText: () => string;
	replaceSelection: Mock<(text: string) => void>;
};

/** 纯链接的正则片段，`embed` 为 true 时带图片嵌入前缀 `!` */
function ipfsLinkPattern(name: string, embed: boolean): string {
	const prefix = embed ? "!" : "";
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `${prefix}\\[${escapedName}\\]\\(ipfs://[^)]+\\)`;
}

/** 插入笔记的链接文本：纯链接独占一行，末尾恰好一个换行 */
function ipfsLinkLine(name: string, embed: boolean): RegExp {
	return new RegExp(`^${ipfsLinkPattern(name, embed)}\\n$`);
}

describe("processFileAndInsertLink", () => {
	beforeEach(() => {
		Notice.instances.length = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	/**
	 * 构造带光标的伪 Editor。
	 *
	 * @param options.applySelection 为 false 时模拟选区已不在编辑器内（view 已关闭），
	 * 用于覆盖占位符回退到 Vault 磁盘替换的分支。
	 */
	function createMockEditor(
		options: {
			text?: string;
			caret?: number;
			applySelection?: boolean;
		} = {},
	) {
		let text = options.text ?? "";
		let caret = options.caret ?? text.length;
		const applySelection = options.applySelection ?? true;
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
				if (!applySelection) {
					return;
				}
				text = text.slice(0, caret) + t + text.slice(caret);
				caret += t.length;
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
					caret = start + t.length;
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
		} as unknown as MockEditor;
	}

	function createMockVault(): PlaceholderReplaceVault {
		return {
			getAbstractFileByPath: vi.fn().mockReturnValue(null),
			process: vi.fn().mockResolvedValue(""),
		};
	}

	/** 构造只暴露插入附件所需接口的伪 App，打开一个固定的笔记 */
	function createMockApp(editor: MockEditor): App {
		return {
			workspace: {
				getActiveViewOfType: vi.fn().mockReturnValue({
					editor,
					file: { path: "notes/regular.md" },
				}),
			},
			vault: createMockVault(),
		} as unknown as App;
	}

	/** 构造 showOpenFilePicker 的返回值：按文件名生成文件句柄 */
	function createFileHandles(names: string[]): FileSystemFileHandle[] {
		return names.map((name) => ({
			getFile: () => Promise.resolve(new File(["data"], name)),
		})) as unknown as FileSystemFileHandle[];
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
		expect(text).toMatch(ipfsLinkLine("photo.png", true));
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

		// 检查立即插入的占位符：占位符本身不带换行
		const initialText = editor.getText();
		expect(initialText).toMatch(
			/^%% Preprocessing attachment: photo\.png\.\.\. \^prep-[0-9a-z]+-[0-9a-z]+ %%$/,
		);
		expect(initialText).not.toContain("\n");

		// 等待后台异步微任务完成
		await new Promise((r) => window.setTimeout(r, 50));

		// 检查占位符是否被替换为带尾随换行的最终 IPFS 链接
		const finalText = editor.getText();
		expect(finalText).toMatch(ipfsLinkLine("photo.png", true));
		expect(finalText).not.toContain("%% Preprocessing attachment");
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
		expect(text).toMatch(ipfsLinkLine("photo.png", true));
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
		expect(text).toMatch(ipfsLinkLine("doc.pdf", false));
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
		expect(text).toMatch(ipfsLinkLine("photo.heic", true));
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

		// eslint-disable-next-line @typescript-eslint/unbound-method
		expect(customPipeline.run).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "photo.heic",
				mimeType: "image/heic",
			}),
		);

		const text = editor.getText();
		expect(text).toMatch(ipfsLinkLine("photo.webp", true));
		expect(text).toContain("format=image%2Fwebp");
	});

	it("inserts plain non-image attachment with a trailing newline when preProcess script is not set", async () => {
		const editor = createMockEditor();
		const file = new File(["test data"], "doc.pdf", {
			type: "application/pdf",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			mockPipelineNoScript,
			createMockVault(),
		);

		expect(editor.getText()).toMatch(ipfsLinkLine("doc.pdf", false));
	});

	it("keeps text before the cursor unchanged and puts the newline right after the link", async () => {
		// 光标位于已有文本行中间，链接插入后换行，光标前的既有内容不被修改
		const editor = createMockEditor({ text: "before after", caret: 7 });
		const file = new File(["test data"], "doc.pdf", {
			type: "application/pdf",
		});

		await processFileAndInsertLink(
			mockCas,
			"attachments",
			editor,
			file,
			"notes/regular.md",
			mockEncryptPathPolicy,
			mockPipelineNoScript,
			createMockVault(),
		);

		expect(editor.getText()).toMatch(
			new RegExp(`^before ${ipfsLinkPattern("doc.pdf", false)}\\nafter$`),
		);
	});

	it("writes the same trailing-newline link to the vault file when the editor no longer holds the placeholder", async () => {
		const editor = createMockEditor({ applySelection: false });
		let written = "";
		let placeholder = "";
		const vaultFile = new TFile();
		vaultFile.path = "notes/regular.md";
		const vault: PlaceholderReplaceVault = {
			getAbstractFileByPath: vi.fn().mockReturnValue(vaultFile),
			process: vi
				.fn()
				.mockImplementation(
					(_file: TFile, fn: (content: string) => string) => {
						written = fn(`# Note\n\n${placeholder}\nEnd`);
						return Promise.resolve(written);
					},
				),
		};
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
		placeholder = editor.replaceSelection.mock.calls[0][0];

		await new Promise((r) => window.setTimeout(r, 50));

		// 与编辑器路径使用同一份带尾随换行的替换文本
		expect(written).toMatch(
			new RegExp(
				`^# Note\\n\\n${ipfsLinkPattern("photo.png", true)}\\n\\nEnd$`,
			),
		);
	});

	it("shows the plain link without a trailing newline when the placeholder can not be replaced", async () => {
		const editor = createMockEditor({ applySelection: false });
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
			// Vault 中也没有占位符：编辑器与磁盘替换都失败
			createMockVault(),
		);

		await new Promise((r) => window.setTimeout(r, 50));

		const notice = Notice.instances[Notice.instances.length - 1];
		expect(notice?.message).toMatch(
			new RegExp(`manually: ${ipfsLinkPattern("photo.png", true)}$`),
		);
	});

	it("inserts each of multiple attachments on its own line", async () => {
		const editor = createMockEditor();
		vi.stubGlobal(
			"showOpenFilePicker",
			vi.fn(() => Promise.resolve(createFileHandles(["a.png", "b.png"]))),
		);

		await insertAttachment(
			createMockApp(editor),
			mockCas,
			"attachments",
			mockEncryptPathPolicy,
			mockPipelineNoScript,
		);

		expect(editor.getText().split("\n")).toEqual([
			expect.stringMatching(
				new RegExp(`^${ipfsLinkPattern("a.png", true)}$`),
			),
			expect.stringMatching(
				new RegExp(`^${ipfsLinkPattern("b.png", true)}$`),
			),
			"",
		]);
	});

	it("inserts each of multiple attachments on its own line when preProcess script is enabled", async () => {
		const editor = createMockEditor();
		vi.stubGlobal(
			"showOpenFilePicker",
			vi.fn(() => Promise.resolve(createFileHandles(["a.png", "b.png"]))),
		);

		await insertAttachment(
			createMockApp(editor),
			mockCas,
			"attachments",
			mockEncryptPathPolicy,
			mockPipelineWithScript,
		);

		await new Promise((r) => window.setTimeout(r, 50));

		expect(editor.getText().split("\n")).toEqual([
			expect.stringMatching(
				new RegExp(`^${ipfsLinkPattern("a.png", true)}$`),
			),
			expect.stringMatching(
				new RegExp(`^${ipfsLinkPattern("b.png", true)}$`),
			),
			"",
		]);
	});
});

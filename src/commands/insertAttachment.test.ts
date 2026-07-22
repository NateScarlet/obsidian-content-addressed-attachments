import { describe, it, expect, vi } from "vitest";
import { processFileAndInsertLink } from "./insertAttachment";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import type { Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";

describe("processFileAndInsertLink", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";
	const dummyCID = CID.parse(validCIDString);

	const mockCas = {
		save: vi.fn().mockResolvedValue({ cid: dummyCID }),
	} as unknown as CAS;

	const mockEncryptionService = {
		resolveKeyForNotePath: vi
			.fn()
			.mockImplementation((path: string) =>
				Promise.resolve(
					path.startsWith("secret/") ? "key123" : undefined,
				),
			),
		encryptFile: vi.fn().mockImplementation((_fp, file: File) =>
			Promise.resolve({
				encryptedFile: new File([new Uint8Array(8)], file.name, {
					type: ENCRYPTED_FORMAT,
				}),
			}),
		),
	} as unknown as EncryptionService;

	function createMockEditor() {
		let text = "";
		return {
			replaceRange: vi.fn((t: string) => {
				text += t;
			}),
			replaceSelection: vi.fn((t: string) => {
				text += t;
			}),
			getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
			setCursor: vi.fn(),
			getSelection: vi.fn().mockReturnValue(""),
			getLine: vi.fn().mockReturnValue(""),
			getText: () => text,
		} as unknown as Editor & { getText: () => string };
	}

	it("saves unencrypted attachment and inserts link when note does not match path rule", async () => {
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
			mockEncryptionService,
		);

		const text = editor.getText();
		expect(text).toContain("![photo.png](ipfs://");
		expect(text).toContain("format=image%2Fpng");
		expect(text).not.toContain(encodeURIComponent(ENCRYPTED_FORMAT));
	});

	it("auto-encrypts pasted/inserted image when note matches path rule", async () => {
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
			mockEncryptionService,
		);

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
			mockEncryptionService,
		);

		const text = editor.getText();
		expect(text.startsWith("[doc.pdf](ipfs://")).toBe(true);
		expect(text.startsWith("!")).toBe(false);
		expect(text).toContain(
			`format=${encodeURIComponent(ENCRYPTED_FORMAT)}`,
		);
	});
});

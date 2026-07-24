import { describe, it, expect, vi } from "vitest";
import { encryptLink, decryptLink, findLinkAtPos } from "./convertAttachment";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import { IPFSLink } from "#src/utils/IPFSLink";
import type { IPFSLinkMatch } from "#src/utils/findIPFSLinks";
import type { App, Editor } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import type { URLResolver } from "#src/URLResolver";
import type ReferenceManager from "#src/ReferenceManager";

describe("convertAttachment", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";
	const dummyCID = CID.parse(validCIDString);

	function ipfsLinkMatch(
		rawUrl: string,
		urlStart: number,
		urlEnd: number,
	): IPFSLinkMatch {
		return {
			pos: [urlStart, urlEnd],
			url: IPFSLink.parse(rawUrl)!,
			isEmbed: false,
		};
	}

	const mockApp = {
		vault: {
			adapter: {
				readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
			},
		},
	} as unknown as App;

	const mockTrash = vi.fn().mockResolvedValue(1);

	const mockCas = {
		load: vi.fn().mockResolvedValue({ normalizedPath: "cas/path" }),
		save: vi.fn().mockImplementation(() =>
			Promise.resolve({
				cid: CID.parse(
					"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
				),
			}),
		),
		trash: mockTrash,
	} as unknown as CAS;

	const mockKeyManager = {
		getPrimaryKey: vi.fn().mockResolvedValue({ fingerprint: "keyfp123" }),
		getKeyForEncrypt: vi
			.fn()
			.mockResolvedValue({ fingerprint: "keyfp123" }),
	};

	const mockEncryptionService = {
		keyManager: mockKeyManager,
		ensureEncrypted: vi.fn().mockImplementation((input: File) =>
			Promise.resolve(
				new File([new Uint8Array(16)], input.name ?? "file", {
					type: ENCRYPTED_FORMAT,
				}),
			),
		),
		ensureDecrypted: vi.fn().mockResolvedValue({
			data: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
			layers: [{ header: {} as unknown }],
			toBlob: () =>
				new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
		}),
	} as unknown as EncryptionService;

	const mockUrlResolver = {
		resolveURL: vi.fn().mockResolvedValue({ path: "cas/path" }),
	} as unknown as URLResolver;

	const mockReferenceManager = {
		findFilePath: vi.fn().mockImplementation(function* () {}),
	} as unknown as ReferenceManager;

	function createMockEditor(initialDoc: string) {
		let doc = initialDoc;

		const editor = {
			offsetToPos: vi.fn((offset: number) => ({ line: 0, ch: offset })),
			replaceRange: vi.fn(
				(
					text: string,
					from: { line: number; ch: number },
					to: { line: number; ch: number },
				) => {
					doc = doc.slice(0, from.ch) + text + doc.slice(to.ch);
				},
			),
			getEditorContent: () => doc,
		} as unknown as Editor & {
			getEditorContent: () => string;
		};

		return editor;
	}

	describe("findLinkAtPos", () => {
		it("detects image embed link position and sets isEmbed = true", () => {
			const url = `ipfs://${validCIDString}?filename=photo.png&format=image%2Fpng`;
			const markdown = `Intro ![photo.png](${url}) outro`;
			const pos = findLinkAtPos(
				markdown,
				markdown.indexOf(validCIDString),
			);

			expect(pos).toBeDefined();
			expect(pos?.isEmbed).toBe(true);
			expect(
				typeof pos?.url.toURL === "function"
					? pos.url.toURL()
					: undefined,
			).toBe(url);
		});

		it("detects attachment link position when cursor is on IPFS URL", () => {
			const url = `ipfs://${validCIDString}?filename=photo.png&format=image%2Fpng`;
			const markdown = `Intro ![photo.png|200](${url}) outro`;
			const pos = findLinkAtPos(
				markdown,
				markdown.indexOf(validCIDString),
			);

			expect(pos).toBeDefined();
			expect(pos?.isEmbed).toBe(true);
			expect(
				typeof pos?.url.toURL === "function"
					? pos.url.toURL()
					: undefined,
			).toBe(url);
			expect(pos?.pos[0]).toBe(markdown.indexOf(url));
			expect(pos?.pos[1]).toBe(markdown.indexOf(url) + url.length);
		});
	});

	describe("encryptLink", () => {
		it("directly replaces the ipfs:// URL leaving ![photo.png](...) embed syntax untouched", async () => {
			const rawUrl = `ipfs://${validCIDString}?filename=photo.png&format=image%2Fpng`;
			const markdown = `Intro ![photo.png|200](${rawUrl}) outro`;
			const urlStart = markdown.indexOf(rawUrl);
			const urlEnd = urlStart + rawUrl.length;

			const editor = createMockEditor(markdown);

			await encryptLink(
				mockApp,
				mockCas,
				mockEncryptionService,
				mockUrlResolver,
				mockReferenceManager,
				"attachments",
				editor,
				ipfsLinkMatch(rawUrl, urlStart, urlEnd),
			);

			const resultDoc = editor.getEditorContent();
			expect(resultDoc.startsWith("Intro ![photo.png|200](ipfs://")).toBe(
				true,
			);
			expect(resultDoc.endsWith(") outro")).toBe(true);
			expect(resultDoc).toContain(
				`format=${encodeURIComponent(ENCRYPTED_FORMAT)}`,
			);
			expect(mockTrash).toHaveBeenCalledWith(dummyCID);
		});
	});

	describe("decryptLink", () => {
		it("directly replaces the ipfs:// URL leaving ![photo.png](...) embed syntax untouched", async () => {
			const rawUrl = `ipfs://${validCIDString}?filename=photo.png&format=${encodeURIComponent(ENCRYPTED_FORMAT)}`;
			const markdown = `Intro ![photo.png|200](${rawUrl}) outro`;
			const urlStart = markdown.indexOf(rawUrl);
			const urlEnd = urlStart + rawUrl.length;

			const editor = createMockEditor(markdown);

			await decryptLink(
				mockApp,
				mockCas,
				mockEncryptionService,
				mockUrlResolver,
				mockReferenceManager,
				"attachments",
				editor,
				ipfsLinkMatch(rawUrl, urlStart, urlEnd),
			);

			const resultDoc = editor.getEditorContent();
			expect(resultDoc.startsWith("Intro ![photo.png|200](ipfs://")).toBe(
				true,
			);
			expect(resultDoc.endsWith(") outro")).toBe(true);
			expect(resultDoc).toContain("format=image%2Fpng");
			expect(mockTrash).toHaveBeenCalledWith(dummyCID);
		});

		it("skips trash when source file is referenced in another note", async () => {
			const rawUrl = `ipfs://${validCIDString}?filename=photo.png&format=image%2Fpng`;
			const markdown = `Intro ![photo.png](${rawUrl}) outro`;
			const urlStart = markdown.indexOf(rawUrl);
			const urlEnd = urlStart + rawUrl.length;

			const refMgr = {
				findFilePath: vi.fn().mockImplementation(function* () {
					yield "OtherNote.md";
				}),
			} as unknown as ReferenceManager;

			const localTrash = vi.fn().mockResolvedValue(1);

			const cas = {
				load: vi.fn().mockResolvedValue({ normalizedPath: "cas/path" }),
				save: vi.fn().mockResolvedValue({
					cid: CID.parse(
						"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
					),
				}),
				trash: localTrash,
			} as unknown as CAS;

			const editor = createMockEditor(markdown);

			await encryptLink(
				mockApp,
				cas,
				mockEncryptionService,
				mockUrlResolver,
				refMgr,
				"attachments",
				editor,
				ipfsLinkMatch(rawUrl, urlStart, urlEnd),
				"CurrentNote.md",
			);

			expect(localTrash).not.toHaveBeenCalled();
		});
	});
});

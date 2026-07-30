import { describe, it, expect } from "vitest";
import IPFSLink from "./IPFSLink";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";

describe("IPFSLink", () => {
	const validCIDString =
		"bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";
	const validURL = `ipfs://${validCIDString}?filename=test.png&format=image%2Fpng`;

	it("parses valid ipfs:// URL", () => {
		const link = IPFSLink.parse(validURL);
		expect(link).toBeDefined();
		expect(link?.cid.toString()).toBe(validCIDString);
		expect(link?.filename).toBe("test.png");
		expect(link?.format).toBe("image/png");
	});

	it("returns undefined for invalid URLs or wrong hostname length", () => {
		expect(IPFSLink.parse("https://example.com")).toBeUndefined();
		expect(IPFSLink.parse("ipfs://shortcid")).toBeUndefined();
	});

	it("identifies encrypted format via format field", () => {
		const encURL = `ipfs://${validCIDString}?filename=secret.txt&format=${encodeURIComponent(ENCRYPTED_FORMAT)}`;
		const link = IPFSLink.parse(encURL);
		expect(link?.format).toBe(ENCRYPTED_FORMAT);
	});

	it("formats markdown embed image when format is image/*", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "photo.jpg",
			format: "image/jpeg",
		});
		expect(link.toMarkdown(true)).toBe(
			`![photo.jpg](ipfs://${validCIDString}?filename=photo.jpg&format=image%2Fjpeg)`,
		);
	});

	it("formats standard markdown link for non-image format by default", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "doc.pdf",
			format: "application/pdf",
		});
		expect(link.toMarkdown(false)).toBe(
			`[doc.pdf](ipfs://${validCIDString}?filename=doc.pdf&format=application%2Fpdf)`,
		);
	});

	it("respects explicit embed option for encrypted images", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "photo.png",
			format: ENCRYPTED_FORMAT,
		});
		expect(link.toMarkdown(true)).toBe(
			`![photo.png](ipfs://${validCIDString}?filename=photo.png&format=${encodeURIComponent(ENCRYPTED_FORMAT)})`,
		);
		expect(link.toMarkdown(false)).toBe(
			`[photo.png](ipfs://${validCIDString}?filename=photo.png&format=${encodeURIComponent(ENCRYPTED_FORMAT)})`,
		);
	});
});

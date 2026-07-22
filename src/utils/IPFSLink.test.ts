import { describe, it, expect } from "vitest";
import { IPFSLink } from "./IPFSLink";
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
		expect(link?.isImage).toBe(true);
		expect(link?.isEncrypted).toBe(false);
	});

	it("returns undefined for invalid URLs or wrong hostname length", () => {
		expect(IPFSLink.parse("https://example.com")).toBeUndefined();
		expect(IPFSLink.parse("ipfs://shortcid")).toBeUndefined();
	});

	it("identifies encrypted format correctly", () => {
		const encURL = `ipfs://${validCIDString}?filename=secret.txt&format=${encodeURIComponent(ENCRYPTED_FORMAT)}`;
		const link = IPFSLink.parse(encURL);
		expect(link?.isEncrypted).toBe(true);
	});

	it("formats markdown embed image for image files", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "photo.jpg",
			format: "image/jpeg",
		});
		expect(link.toMarkdown()).toBe(
			`![photo.jpg](ipfs://${validCIDString}?filename=photo.jpg&format=image%2Fjpeg)`,
		);
	});

	it("formats standard markdown link for non-image files", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "doc.pdf",
			format: "application/pdf",
		});
		expect(link.toMarkdown()).toBe(
			`[doc.pdf](ipfs://${validCIDString}?filename=doc.pdf&format=application%2Fpdf)`,
		);
	});

	it("prioritizes explicit format over filename extension for isImage", () => {
		const cid = CID.parse(validCIDString);
		const link = new IPFSLink({
			cid,
			filename: "fake.png",
			format: "application/octet-stream",
		});
		expect(link.isImage).toBe(false);
	});
});

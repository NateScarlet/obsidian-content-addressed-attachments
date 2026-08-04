import { describe, it, expect, vi } from "vitest";
import { parseScriptURL, getParams } from "./ScriptLoader";

describe("parseScriptURL", () => {
	it("parses vault-relative path", () => {
		const result = parseScriptURL("scripts/transform.js");
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: {},
		});
	});

	it("parses vault-relative path with params", () => {
		const result = parseScriptURL(
			"scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: { format: "avif", quality: "80" },
		});
	});

	it("parses ipfs:// URL", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: {},
		});
	});

	it("parses ipfs:// URL with params", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di#format=avif",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: { format: "avif" },
		});
	});

	it("parses internal.ipfs-locked: URL", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: {},
		});
	});

	it("parses internal.ipfs-locked: URL with params", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js#format=webp",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: { format: "webp" },
		});
	});

	it("parses https:// URL", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: {},
		});
	});

	it("parses https:// URL with params", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: { format: "avif", quality: "80" },
		});
	});

	it("returns undefined for empty string", () => {
		expect(parseScriptURL("")).toBeUndefined();
		expect(parseScriptURL("   ")).toBeUndefined();
	});

	it("returns undefined for invalid internal.ipfs-locked: URL without comma", () => {
		const result = parseScriptURL("internal.ipfs-locked:bafkreiabc123");
		expect(result).toBeUndefined();
	});

	it("treats unknown scheme as vault-relative path", () => {
		// "unknown:something" - "unknown:" is not in KNOWN_SCHEMES
		// So it should be treated as vault-relative path
		const result = parseScriptURL("unknown:something");
		expect(result).toEqual({
			type: "vault-relative",
			path: "unknown:something",
			params: {},
		});
	});
});

describe("getParams", () => {
	it("extracts params from URL fragment", () => {
		const params = getParams("scripts/transform.js#format=avif&quality=80");
		expect(params).toEqual({ format: "avif", quality: "80" });
	});

	it("returns empty object for URL without fragment", () => {
		const params = getParams("scripts/transform.js");
		expect(params).toEqual({});
	});

	it("handles fragment with no value keys", () => {
		const params = getParams("scripts/transform.js#flag");
		expect(params).toEqual({ flag: "" });
	});

	it("returns empty object for empty string", () => {
		expect(getParams("")).toEqual({});
	});
});
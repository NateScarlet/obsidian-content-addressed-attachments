import { describe, it, expect } from "vitest";
import { parseScriptURL } from "./ScriptLoader";

/** 将 URLSearchParams 转为普通对象以便断言 */
function paramsToObject(params: URLSearchParams): Record<string, string> {
	const obj: Record<string, string> = {};
	params.forEach((value, key) => {
		obj[key] = value;
	});
	return obj;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
describe("parseScriptURL", () => {
	it("parses vault-relative path", () => {
		const result = parseScriptURL("scripts/transform.js");
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses vault-relative path with params", () => {
		const result = parseScriptURL(
			"scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "vault-relative",
			path: "scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("parses ipfs:// URL", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses ipfs:// URL with params", () => {
		const result = parseScriptURL(
			"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di#format=avif",
		);
		expect(result).toEqual({
			type: "ipfs",
			cid: "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({ format: "avif" });
	});

	it("parses internal.ipfs-locked: URL", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses internal.ipfs-locked: URL with params", () => {
		const result = parseScriptURL(
			"internal.ipfs-locked:bafkreiabc123,https://example.com/script.js#format=webp",
		);
		expect(result).toEqual({
			type: "internal.ipfs-locked",
			cid: "bafkreiabc123",
			sourceURL: "https://example.com/script.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({ format: "webp" });
	});

	it("parses https:// URL", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({});
	});

	it("parses https:// URL with params", () => {
		const result = parseScriptURL(
			"https://example.com/scripts/transform.js#format=avif&quality=80",
		);
		expect(result).toEqual({
			type: "https",
			url: "https://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
		});
		expect(paramsToObject(result!.params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("parses http:// URL", () => {
		const result = parseScriptURL(
			"http://example.com/scripts/transform.js",
		);
		expect(result).toEqual({
			type: "https",
			url: "http://example.com/scripts/transform.js",
			params: expect.any(URLSearchParams),
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

	it("returns undefined for absolute Windows path", () => {
		expect(parseScriptURL("C:\\scripts\\transform.js")).toBeUndefined();
	});

	it("returns undefined for absolute POSIX path", () => {
		expect(parseScriptURL("/scripts/transform.js")).toBeUndefined();
	});

	it("treats unknown scheme followed by path as vault-relative path", () => {
		const result = parseScriptURL("unknown:something");
		expect(result).toEqual({
			type: "vault-relative",
			path: "unknown:something",
			params: expect.any(URLSearchParams),
		});
	});
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

describe("ScriptLoaderImpl.getParams", () => {
	it("extracts params from URL fragment", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl(
			(path) => path,
			() => Promise.resolve(undefined),
			() => Promise.resolve(false),
			() => Promise.resolve(undefined),
			() => "",
			() => "",
			() => "",
			() => Promise.resolve(undefined),
		);
		const params = loader.getParams(
			"scripts/transform.js#format=avif&quality=80",
		);
		expect(paramsToObject(params)).toEqual({
			format: "avif",
			quality: "80",
		});
	});

	it("returns empty URLSearchParams for URL without fragment", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl(
			(path) => path,
			() => Promise.resolve(undefined),
			() => Promise.resolve(false),
			() => Promise.resolve(undefined),
			() => "",
			() => "",
			() => "",
			() => Promise.resolve(undefined),
		);
		const params = loader.getParams("scripts/transform.js");
		expect(paramsToObject(params)).toEqual({});
	});

	it("returns empty URLSearchParams for empty string", async () => {
		const { default: ScriptLoaderImpl } = await import("./ScriptLoader");
		const loader = new ScriptLoaderImpl(
			(path) => path,
			() => Promise.resolve(undefined),
			() => Promise.resolve(false),
			() => Promise.resolve(undefined),
			() => "",
			() => "",
			() => "",
			() => Promise.resolve(undefined),
		);
		expect(paramsToObject(loader.getParams(""))).toEqual({});
	});
});

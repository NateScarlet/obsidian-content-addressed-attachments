import { describe, it, expect } from "vitest";
import {
	findScriptByURL,
	getIndexedScriptURLs,
	SCRIPT_INDEX,
} from "./scriptIndex";

describe("scriptIndex", () => {
	it("has valid script index entries", () => {
		expect(SCRIPT_INDEX.length).toBeGreaterThan(0);
		for (const entry of SCRIPT_INDEX) {
			expect(entry.name).toBeTruthy();
			// 描述必须同时提供中英文案，按用户界面语言显示
			expect(entry.description.en).toBeTruthy();
			expect(entry.description.zh).toBeTruthy();
			expect(entry.scriptURL).toBeTruthy();
		}
	});

	it("has unique names across all entries", () => {
		const names = SCRIPT_INDEX.map((e) => e.name);
		const uniqueNames = new Set(names);
		expect(uniqueNames.size).toBe(names.length);
	});

	it("has unique scriptURLs across all entries", () => {
		const urls = SCRIPT_INDEX.map((e) => {
			const hashIndex = e.scriptURL.indexOf("#");
			return hashIndex >= 0
				? e.scriptURL.slice(0, hashIndex)
				: e.scriptURL;
		});
		const uniqueUrls = new Set(urls);
		expect(uniqueUrls.size).toBe(urls.length);
	});

	it("finds script by full URL", () => {
		const entry = SCRIPT_INDEX[0];
		const found = findScriptByURL(entry.scriptURL);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("finds script by URL without fragment", () => {
		const entry = SCRIPT_INDEX[0];
		const hashIndex = entry.scriptURL.indexOf("#");
		const baseURL =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		const found = findScriptByURL(baseURL);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("finds script by URL with different fragment params", () => {
		const entry = SCRIPT_INDEX[0];
		const hashIndex = entry.scriptURL.indexOf("#");
		const baseURL =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		const found = findScriptByURL(`${baseURL}#format=webp&quality=90`);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("returns undefined for unknown URL", () => {
		const found = findScriptByURL("unknown://url");
		expect(found).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		const found = findScriptByURL("");
		expect(found).toBeUndefined();
	});

	it("getIndexedScriptURLs returns all base URLs", () => {
		const urls = getIndexedScriptURLs();
		expect(urls.size).toBe(SCRIPT_INDEX.length);
		for (const entry of SCRIPT_INDEX) {
			const hashIndex = entry.scriptURL.indexOf("#");
			const base =
				hashIndex >= 0
					? entry.scriptURL.slice(0, hashIndex)
					: entry.scriptURL;
			expect(urls.has(base)).toBe(true);
		}
	});
});

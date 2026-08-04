import { describe, it, expect } from "vitest";
import {
	findPresetByURL,
	getPresetBaseURLs,
	PRESET_INDEX,
} from "./presetIndex";

describe("presetIndex", () => {
	it("has valid preset entries", () => {
		expect(PRESET_INDEX.length).toBeGreaterThan(0);
		for (const entry of PRESET_INDEX) {
			expect(entry.name).toBeTruthy();
			expect(entry.description).toBeTruthy();
			expect(entry.scriptURL).toContain("internal.ipfs-locked:");
		}
	});

	it("finds preset by full URL", () => {
		const entry = PRESET_INDEX[0];
		const found = findPresetByURL(entry.scriptURL);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("finds preset by URL without fragment", () => {
		const entry = PRESET_INDEX[0];
		const hashIndex = entry.scriptURL.indexOf("#");
		const baseURL =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		const found = findPresetByURL(baseURL);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("finds preset by URL with different fragment params", () => {
		const entry = PRESET_INDEX[0];
		const hashIndex = entry.scriptURL.indexOf("#");
		const baseURL =
			hashIndex >= 0
				? entry.scriptURL.slice(0, hashIndex)
				: entry.scriptURL;
		const found = findPresetByURL(`${baseURL}#format=webp&quality=90`);
		expect(found).toBeDefined();
		expect(found?.name).toBe(entry.name);
	});

	it("returns undefined for unknown URL", () => {
		const found = findPresetByURL("unknown://url");
		expect(found).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		const found = findPresetByURL("");
		expect(found).toBeUndefined();
	});

	it("getPresetBaseURLs returns all base URLs", () => {
		const urls = getPresetBaseURLs();
		expect(urls.size).toBe(PRESET_INDEX.length);
		for (const entry of PRESET_INDEX) {
			const hashIndex = entry.scriptURL.indexOf("#");
			const base =
				hashIndex >= 0
					? entry.scriptURL.slice(0, hashIndex)
					: entry.scriptURL;
			expect(urls.has(base)).toBe(true);
		}
	});
});

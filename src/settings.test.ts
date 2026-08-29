import { describe, it, expect } from "vitest";
import { settingsFromInput, getDefaultSettings } from "./settings";

describe("settingsFromInput", () => {
	it("returns default settings when input is null or undefined", () => {
		const defaults = getDefaultSettings();
		expect(settingsFromInput(null)).toEqual(defaults);
		expect(settingsFromInput(undefined)).toEqual(defaults);
	});

	it("preserves configured gateways when version === 1", () => {
		const customGateways = [
			{
				name: "Custom Gateway",
				urlTemplate: "https://custom.com/{{cid}}",
				headers: [],
				enabled: true,
			},
		];
		const result = settingsFromInput({
			version: 1,
			primaryDir: ".attachments/cas",
			downloadDir: "",
			gateways: customGateways,
		});

		expect(result.gateways).toEqual(customGateways);
	});

	it("throws error when encountering unsupported future settings version (> 1)", () => {
		expect(() =>
			settingsFromInput({
				version: 2,
			}),
		).toThrow("Unsupported settings version 2");
	});

	it("respects user decision when gateways array is explicitly empty []", () => {
		const resultEmpty = settingsFromInput({
			version: 1,
			primaryDir: ".attachments/cas",
			downloadDir: "",
			gateways: [],
		});
		expect(resultEmpty.gateways).toEqual([]);
	});

	it("falls back to default gateways when gateways field is missing (undefined)", () => {
		const defaults = getDefaultSettings();
		const resultMissing = settingsFromInput({
			version: 1,
			primaryDir: ".attachments/cas",
			downloadDir: "",
		});
		expect(resultMissing.gateways).toEqual(defaults.gateways);
	});

	it("migrates v0 settings to v1 correctly without wiping gateways", () => {
		const defaults = getDefaultSettings();
		const result = settingsFromInput({
			version: undefined,
			casDir: "custom/cas",
		});

		expect(result.version).toBe(1);
		expect(result.primaryDir).toBe("custom/cas");
		expect(result.gateways).toEqual(defaults.gateways);
	});

	it("includes empty headerRules in defaults", () => {
		const defaults = getDefaultSettings();
		expect(defaults.headerRules).toEqual([]);
	});

	it("preserves configured headerRules when version === 1", () => {
		const customRules = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]] as [
					string,
					string,
				][],
			},
		];
		const result = settingsFromInput({
			version: 1,
			headerRules: customRules,
		});
		expect(result.headerRules).toEqual(customRules);
	});

	it("falls back to empty headerRules when headerRules field is missing", () => {
		const result = settingsFromInput({
			version: 1,
			primaryDir: ".attachments/cas",
			downloadDir: "",
		});
		expect(result.headerRules).toEqual([]);
	});

	it("migrates v0 settings with empty headerRules", () => {
		const result = settingsFromInput({
			version: undefined,
			casDir: "custom/cas",
		});
		expect(result.headerRules).toEqual([]);
	});
});

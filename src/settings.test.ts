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
					primaryDir: ".attachments/cas",
					downloadDir: "",
				} as any),
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
});

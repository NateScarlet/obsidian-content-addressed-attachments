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

	it("falls back to default gateways if gateways array is empty or missing in input", () => {
		const defaults = getDefaultSettings();
		const resultEmpty = settingsFromInput({
			version: 1,
			primaryDir: ".attachments/cas",
			downloadDir: "",
			gateways: [],
		});
		expect(resultEmpty.gateways).toEqual(defaults.gateways);

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

import { describe, it, expect } from "vitest";
import {
	settingsFromInput,
	getDefaultSettings,
	getDownloadDirs,
	DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
	normalizeMaxWholeBodyBytes,
	normalizeMaxWholeBodyBytesInput,
} from "./settings";

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

describe("下载目录保留期与配额", () => {
	it("缺省时保留期为 7 天、配额为 0（不启用自动清理）", () => {
		const defaults = getDefaultSettings();
		expect(defaults.downloadRetentionDays).toBe(7);
		expect(defaults.downloadQuotaBytes).toBe(0);
		expect(settingsFromInput({ version: 1 })).toEqual(defaults);
	});

	it("保留期允许小数并原样保留", () => {
		const result = settingsFromInput({
			version: 1,
			downloadRetentionDays: 0.5,
		});
		expect(result.downloadRetentionDays).toBe(0.5);
	});

	it("保留期为 0 表示全部副本可删，不被替换为默认值", () => {
		const result = settingsFromInput({
			version: 1,
			downloadRetentionDays: 0,
		});
		expect(result.downloadRetentionDays).toBe(0);
	});

	it("保留期为负数时钳到 0", () => {
		const result = settingsFromInput({
			version: 1,
			downloadRetentionDays: -3,
		});
		expect(result.downloadRetentionDays).toBe(0);
	});

	it("保留期缺失或非有限数值时回落到默认值", () => {
		expect(
			settingsFromInput({ version: 1, downloadRetentionDays: undefined })
				.downloadRetentionDays,
		).toBe(7);
		expect(
			settingsFromInput({
				version: 1,
				downloadRetentionDays: Number.NaN,
			}).downloadRetentionDays,
		).toBe(7);
	});

	it("配额原样保留，≤0 表示不启用自动清理", () => {
		expect(
			settingsFromInput({
				version: 1,
				downloadQuotaBytes: 512 * 1024 * 1024,
			}).downloadQuotaBytes,
		).toBe(512 * 1024 * 1024);
		expect(
			settingsFromInput({ version: 1, downloadQuotaBytes: -1 })
				.downloadQuotaBytes,
		).toBe(-1);
	});

	it("配额非有限数值时回落到 0（禁用自动清理）", () => {
		expect(
			settingsFromInput({
				version: 1,
				downloadQuotaBytes: Number.POSITIVE_INFINITY,
			}).downloadQuotaBytes,
		).toBe(0);
	});

	it("v0 迁移同样带上默认保留期与配额", () => {
		const result = settingsFromInput({
			version: undefined,
			casDir: "custom/cas",
		});
		expect(result.downloadRetentionDays).toBe(7);
		expect(result.downloadQuotaBytes).toBe(0);
	});
});

describe("整包下载上限", () => {
	it("缺省时使用默认上限，v0 迁移同样带上", () => {
		const defaults = getDefaultSettings();
		expect(defaults.maxWholeBodyDownloadBytes).toBe(
			DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
		);
		expect(settingsFromInput({ version: 1 })).toEqual(defaults);
		expect(
			settingsFromInput({ version: undefined, casDir: "custom/cas" })
				.maxWholeBodyDownloadBytes,
		).toBe(DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES);
	});

	it("显式配置的字节数原样保留", () => {
		expect(
			settingsFromInput({
				version: 1,
				maxWholeBodyDownloadBytes: 8 * 1024 * 1024,
			}).maxWholeBodyDownloadBytes,
		).toBe(8 * 1024 * 1024);
	});

	it("负数钳到 0，表示永不允许整包下载", () => {
		expect(
			settingsFromInput({ version: 1, maxWholeBodyDownloadBytes: -5 })
				.maxWholeBodyDownloadBytes,
		).toBe(0);
	});

	it("非有限数值回落到默认上限", () => {
		expect(
			settingsFromInput({
				version: 1,
				maxWholeBodyDownloadBytes: Number.NaN,
			}).maxWholeBodyDownloadBytes,
		).toBe(DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES);
	});

	it("界面输入按 MB 解析，空输入回落到默认上限而不是 0", () => {
		expect(normalizeMaxWholeBodyBytesInput("8")).toBe(8 * 1024 * 1024);
		expect(normalizeMaxWholeBodyBytesInput("0")).toBe(0);
		expect(normalizeMaxWholeBodyBytesInput("")).toBe(
			DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
		);
		expect(normalizeMaxWholeBodyBytesInput("abc")).toBe(
			DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
		);
	});

	it("归一函数对非法值保持默认，负值钳到 0", () => {
		expect(normalizeMaxWholeBodyBytes(undefined)).toBe(
			DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
		);
		expect(normalizeMaxWholeBodyBytes(Number.POSITIVE_INFINITY)).toBe(
			DEFAULT_MAX_WHOLE_BODY_DOWNLOAD_BYTES,
		);
		expect(normalizeMaxWholeBodyBytes(-1)).toBe(0);
		expect(normalizeMaxWholeBodyBytes(0)).toBe(0);
	});
});

describe("getDownloadDirs 设置读取函数", () => {
	// 验证设置读取形态按当前设置返回完整目录（含仅用于读取的网关目录）；
	// 口径规则本身由 downloadDirPolicy.test.ts 覆盖
	it("按当前设置返回完整下载目录", () => {
		const settings = settingsFromInput({
			version: 1,
			downloadDir: "dl",
			gateways: [
				{
					name: "只读",
					urlTemplate: "",
					headers: [],
					enabled: true,
					downloadDir: "external",
				},
				{
					name: "停用",
					urlTemplate: "https://off.example/{{cid}}",
					headers: [],
					enabled: false,
					downloadDir: "off",
				},
			],
		});

		expect(getDownloadDirs(settings)).toEqual(["dl", "external"]);

		settings.gateways[1].enabled = true;
		expect(getDownloadDirs(settings)).toEqual(["dl", "external", "off"]);
	});
});

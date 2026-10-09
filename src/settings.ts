import type { GatewayConfig, HeaderRule } from "./URLResolver";
import defineLocales from "./utils/defineLocales";

export const CURRENT_SETTINGS_VERSION = 1;

export const EXAMPLE_URL =
	"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di?filename=image.png&format=image%2Fpng";

export interface EncryptPathRule {
	pattern: string;
	keyFingerprint: string;
}

export interface PreProcessSettings {
	/** 预处理脚本 URL，空字符串表示禁用 */
	scriptURL: string;
}

export interface Settings {
	version: 1;
	primaryDir: string;
	downloadDir: string;
	/**
	 * 下载目录副本保留期（天，允许小数）。
	 * 按副本创建时间判定：早于保留期的副本可被手动与自动清理删除。
	 * 字面语义：0 表示全部副本可删，负值按 0 处理。
	 */
	downloadRetentionDays: number;
	/**
	 * 全部下载目录占用字节上限，超过时在写入新副本之前触发自动清理；
	 * ≤0 表示不启用自动清理。
	 */
	downloadQuotaBytes: number;
	gateways: GatewayConfig[];
	/** 按 URL 前缀匹配的全局请求头规则 */
	headerRules: HeaderRule[];
	encryptPathRules: EncryptPathRule[];
	maxBlobSize: number;
	decryptedCacheDir: string;
	encryptionKeysSecretId?: string;
	preProcess: PreProcessSettings;
}

export const DEFAULT_MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20MB
export const DEFAULT_DECRYPTED_CACHE_DIR = "";
/** 下载目录副本的默认保留期（天） */
export const DEFAULT_DOWNLOAD_RETENTION_DAYS = 7;
/** 默认下载配额（字节）：0 表示不启用基于配额的自动清理 */
export const DEFAULT_DOWNLOAD_QUOTA_BYTES = 0;

interface SettingsV0 {
	version: undefined;
	casDir?: string;
	gatewayURLs?: {
		urlTemplate: string;
		name: string;
		headers: [key: string, value: string][];
		enabled: boolean;
	}[];
}

interface SettingsV1Input {
	version: 1;
	primaryDir?: string;
	downloadDir?: string;
	downloadRetentionDays?: number;
	downloadQuotaBytes?: number;
	gateways?: GatewayConfig[];
	headerRules?: HeaderRule[];
	encryptPathRules?: EncryptPathRule[];
	maxBlobSize?: number;
	decryptedCacheDir?: string;
	encryptionKeysSecretId?: string;
	preProcess?: PreProcessSettings;
}

export type SettingsInput = SettingsV0 | SettingsV1Input | { version: number };

/**
 * 保留期归一：缺失或非有限数值回落到默认（保守：近期副本不可删）；
 * 负值钳到 0（保留期为 0 的字面语义即全部副本可删）。
 */
export function normalizeRetentionDays(value: number | undefined): number {
	if (value == null || !Number.isFinite(value)) {
		return DEFAULT_DOWNLOAD_RETENTION_DAYS;
	}
	return value < 0 ? 0 : value;
}

/** 配额归一：缺失或非有限数值按 0（不启用自动清理）处理 */
function normalizeQuotaBytes(value: number | undefined): number {
	return value != null && Number.isFinite(value)
		? value
		: DEFAULT_DOWNLOAD_QUOTA_BYTES;
}

/** 下载配额的界面输入单位（兆字节） */
export const BYTES_PER_MB = 1024 * 1024;

/**
 * 保留期文本输入归一（设置页与文件管理器共用，避免两处解析规则分叉）。
 * 空输入不按 0 处理——0 的字面语义是全部副本可删——而是回落到默认保留期。
 */
export function normalizeRetentionDaysInput(value: string): number {
	return normalizeRetentionDays(
		value.trim() === "" ? Number.NaN : Number(value),
	);
}

/** 下载配额文本输入（MB）归一为字节：空输入与非法数值按 0（不启用自动清理）处理 */
export function normalizeQuotaBytesInput(value: string): number {
	const mb = value.trim() === "" ? Number.NaN : Number(value);
	return normalizeQuotaBytes(
		Number.isFinite(mb) ? mb * BYTES_PER_MB : Number.NaN,
	);
}

export function settingsFromInput(
	input: SettingsInput | null | undefined,
): Settings {
	const defaults = getDefaultSettings();
	if (!input) {
		return defaults;
	}

	// 遭遇未来不识别的高版本配置，遵循“快速失败”原则报错拒绝执行
	if (
		typeof input.version === "number" &&
		input.version > CURRENT_SETTINGS_VERSION
	) {
		throw new Error(
			t("unsupportedSettingsVersion")(
				input.version,
				CURRENT_SETTINGS_VERSION,
			),
		);
	}

	// 当前版本 version === 1
	if (input.version === CURRENT_SETTINGS_VERSION) {
		const v1 = input as SettingsV1Input;
		return {
			...defaults,
			...v1,
			version: 1,
			gateways: Array.isArray(v1.gateways)
				? v1.gateways
				: defaults.gateways,
			downloadRetentionDays: normalizeRetentionDays(
				v1.downloadRetentionDays,
			),
			downloadQuotaBytes: normalizeQuotaBytes(v1.downloadQuotaBytes),
			headerRules: v1.headerRules ?? [],
			encryptPathRules: v1.encryptPathRules ?? [],
			maxBlobSize: v1.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE,
			decryptedCacheDir:
				v1.decryptedCacheDir ?? DEFAULT_DECRYPTED_CACHE_DIR,
			preProcess: v1.preProcess ?? { scriptURL: "" },
		};
	}

	// 无 version 标识的早期旧版本 v0 数据迁移
	const v0 = input as SettingsV0;
	const v0Gateways = Array.isArray(v0.gatewayURLs)
		? v0.gatewayURLs.map((g) => ({
				urlTemplate: g.urlTemplate,
				name: g.name,
				headers: g.headers,
				enabled: g.enabled,
			}))
		: defaults.gateways;

	return {
		...defaults,
		version: 1,
		primaryDir: v0.casDir || defaults.primaryDir,
		downloadDir: "",
		gateways: v0Gateways,
		headerRules: [],
		encryptPathRules: [],
		maxBlobSize: DEFAULT_MAX_BLOB_SIZE,
		decryptedCacheDir: DEFAULT_DECRYPTED_CACHE_DIR,
		preProcess: { scriptURL: "" },
	};
}

export function getDefaultSettings(): Settings {
	return {
		version: 1,
		primaryDir: ".attachments/cas",
		downloadDir: "",
		downloadRetentionDays: DEFAULT_DOWNLOAD_RETENTION_DAYS,
		downloadQuotaBytes: DEFAULT_DOWNLOAD_QUOTA_BYTES,
		gateways: [
			{
				name: "IPFS.io",
				urlTemplate:
					"https://ipfs.io/ipfs/{{cid}}{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: true,
			},
			{
				name: "dweb.link",
				urlTemplate:
					"https://{{cid}}.ipfs.dweb.link{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: true,
			},
			{
				name: "4EVERLAND",
				urlTemplate:
					"https://{{cid}}.ipfs.4everland.io{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: false,
			},
			{
				name: t("localGatewayExample"),
				urlTemplate:
					"http://127.0.0.1:8080/ipfs/{{cid}}{{{url.pathname}}}{{{url.search}}}",
				headers: [],
				enabled: false,
			},
			{
				name: t("githubExample"),
				urlTemplate:
					"https://raw.githubusercontent.com/OWNER/REPO/main/{{{#encodeURI}}}{{{casPath}}}{{{/encodeURI}}}",
				headers: [
					["Authorization", "Token YOUR_PERSONAL_ACCESS_TOKEN"],
				],
				enabled: false,
			},
		],
		headerRules: [],
		encryptPathRules: [],
		maxBlobSize: DEFAULT_MAX_BLOB_SIZE,
		decryptedCacheDir: DEFAULT_DECRYPTED_CACHE_DIR,
		preProcess: { scriptURL: "" },
	};
}

/**
 * 下载目录列表：主下载目录与各网关专属下载目录（去重、忽略空值）。
 * 恢复仅锁定引用的文件时只允许落盘这些目录。
 */
export function getDownloadDirs(settings: Settings): string[] {
	return [
		...new Set([
			settings.downloadDir,
			...settings.gateways.map((g) => g.downloadDir ?? ""),
		]),
	].filter(Boolean);
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		localGatewayExample: "Local gateway example",
		githubExample: "GitHub repository example",
		unsupportedSettingsVersion: (v: number, max: number) =>
			`Unsupported settings version ${v} (max supported version is ${max}). Please update the plugin.`,
	},
	zh: {
		localGatewayExample: "本地网关示例",
		githubExample: "GitHub 仓库示例",
		unsupportedSettingsVersion: (v: number, max: number) =>
			`不支持的设置配置版本 v${v}（当前插件最大支持版本为 v${max}）。请更新插件。`,
	},
});
//#endregion

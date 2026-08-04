import type { GatewayConfig } from "./URLResolver";
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
	gateways: GatewayConfig[];
	encryptPathRules: EncryptPathRule[];
	maxBlobSize: number;
	decryptedCacheDir: string;
	encryptionKeysSecretId?: string;
	preProcess: PreProcessSettings;
}

export const DEFAULT_MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20MB
export const DEFAULT_DECRYPTED_CACHE_DIR = "";

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
	gateways?: GatewayConfig[];
	encryptPathRules?: EncryptPathRule[];
	maxBlobSize?: number;
	decryptedCacheDir?: string;
	encryptionKeysSecretId?: string;
	preProcess?: PreProcessSettings;
}

export type SettingsInput = SettingsV0 | SettingsV1Input | { version: number };

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
		encryptPathRules: [],
		maxBlobSize: DEFAULT_MAX_BLOB_SIZE,
		decryptedCacheDir: DEFAULT_DECRYPTED_CACHE_DIR,
		preProcess: { scriptURL: "" },
	};
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

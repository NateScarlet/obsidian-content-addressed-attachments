import type { GatewayConfig } from "./URLResolver";
import defineLocales from "./utils/defineLocales";

export const EXAMPLE_URL =
	"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di?filename=image.png&format=image%2Fpng";

export interface EncryptPathRule {
	pattern: string;
	keyFingerprint: string;
}

export interface Settings {
	version: 1;
	primaryDir: string;
	downloadDir: string;
	gateways: GatewayConfig[];
	encryptPathRules: EncryptPathRule[];
	maxBlobSize: number;
	decryptedCacheDir: string;
}

export const DEFAULT_MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20MB
export const DEFAULT_DECRYPTED_CACHE_DIR = ".attachments/cas/decrypted-cache";

interface SettingsV0 {
	version: undefined;
	casDir: string;
	gatewayURLs: {
		urlTemplate: string;
		name: string;
		headers: [key: string, value: string][];
		enabled: boolean;
	}[];
}

export type SettingsInput = SettingsV0 | { version: 1; primaryDir: string; downloadDir: string; gateways: GatewayConfig[]; encryptPathRules?: EncryptPathRule[]; maxBlobSize?: number; decryptedCacheDir?: string; };

export function settingsFromInput(input: SettingsInput): Settings {
	if (input.version === 1) {
		return { ...input, encryptPathRules: input.encryptPathRules ?? [], maxBlobSize: input.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE, decryptedCacheDir: input.decryptedCacheDir ?? DEFAULT_DECRYPTED_CACHE_DIR };
	}
	const v0 = input as SettingsV0;
	return {
		version: 1,
		primaryDir: v0.casDir,
		downloadDir: "",
		gateways: (v0.gatewayURLs ?? []).map((g) => ({
			urlTemplate: g.urlTemplate,
			name: g.name,
			headers: g.headers,
			enabled: g.enabled,
		})),
		encryptPathRules: [],
		maxBlobSize: DEFAULT_MAX_BLOB_SIZE,
		decryptedCacheDir: DEFAULT_DECRYPTED_CACHE_DIR,
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
	};
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		localGatewayExample: "Local gateway example",
		githubExample: "GitHub repository example",
	},
	zh: {
		localGatewayExample: "本地网关示例",
		githubExample: "GitHub 仓库示例",
	},
});
//#endregion

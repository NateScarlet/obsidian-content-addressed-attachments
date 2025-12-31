import type { GatewayConfig } from "./URLResolver";
import defineLocales from "./utils/defineLocales";

export const EXAMPLE_URL =
	"ipfs://bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di?filename=image.png&format=image%2Fpng";

interface SettingsV1 {
	version: 1;
	primaryDir: string;
	downloadDir: string;
	gateways: GatewayConfig[];
}

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

export type SettingsInput = SettingsV0 | SettingsV1;

export type Settings = SettingsV1;

export function settingsFromInput(input: SettingsInput): Settings {
	if (input.version === 1) {
		return input;
	}
	return {
		version: 1,
		primaryDir: input.casDir,
		downloadDir: "",
		gateways: input.gatewayURLs,
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
	};
}

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		localGatewayExample: "Local Gateway Example",
		githubExample: "Github Repository Example",
	},
	zh: {
		localGatewayExample: "本地网关示例",
		githubExample: "Github 仓库示例",
	},
});
//#endregion

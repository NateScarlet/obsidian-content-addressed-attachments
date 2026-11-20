import { describe, it, expect } from "vitest";
import {
	allDownloadDirs,
	gatewayProducesSource,
	quotaDownloadDirs,
	selectLandingDir,
	type GatewayConfig,
} from "./downloadDirPolicy";

/** 构造一份仅关心目录口径的网关配置 */
function gateway(
	name: string,
	overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
	return {
		name,
		urlTemplate: "https://gw.example/{{cid}}",
		headers: [],
		enabled: true,
		...overrides,
	};
}

describe("gatewayProducesSource 网关是否产生远程来源", () => {
	it("URL 模板非空时产生来源，为空时仅用于读取", () => {
		expect(
			gatewayProducesSource({
				urlTemplate: "https://gw.example/{{cid}}",
			}),
		).toBe(true);
		expect(gatewayProducesSource({ urlTemplate: "" })).toBe(false);
	});
});

describe("allDownloadDirs 完整下载目录列表", () => {
	it("包含仅用于读取的网关目录，去重并忽略空值", () => {
		// 仅用于读取的目录仍在读取范围与文件管理器「下载」标签页内，
		// 因此不因配额排除而从本列表消失（排除只作用于配额口径）
		const dirs = allDownloadDirs({
			downloadDir: "dl",
			gateways: [
				gateway("read-only", {
					urlTemplate: "",
					downloadDir: "external",
				}),
				gateway("remote", { downloadDir: "gw" }),
				gateway("no-dir"),
				gateway("duplicate", { downloadDir: "dl" }),
			],
		});

		expect(dirs).toEqual(["dl", "external", "gw"]);
	});

	it("排除被禁用网关声明的目录，重新启用后恢复", () => {
		const disabled = [
			gateway("off", { enabled: false, downloadDir: "off" }),
		];
		// 禁用等价于不存在：不声明副本位置，其目录不进入任何口径
		expect(
			allDownloadDirs({ downloadDir: "dl", gateways: disabled }),
		).toEqual(["dl"]);

		expect(
			allDownloadDirs({
				downloadDir: "dl",
				gateways: [{ ...disabled[0], enabled: true }],
			}),
		).toEqual(["dl", "off"]);
	});

	it("被禁用网关与全局下载目录重名时该目录仍在列表内", () => {
		// 判据按目录集合而非配置来源：全局下载目录声明了它就仍参与
		expect(
			allDownloadDirs({
				downloadDir: "shared",
				gateways: [
					gateway("off", { enabled: false, downloadDir: "shared" }),
				],
			}),
		).toEqual(["shared"]);
	});
});

describe("quotaDownloadDirs 参与配额的下载目录", () => {
	it("只含全局下载目录与会产生来源的启用网关目录", () => {
		// 仅读取目录、禁用网关目录均不参与配额：清理会直接删磁盘文件，
		// 把这些目录计入会替外部应用删文件
		const dirs = quotaDownloadDirs("dl", [
			gateway("remote", { downloadDir: "gw" }),
			gateway("read-only", { urlTemplate: "", downloadDir: "external" }),
			gateway("off", { enabled: false, downloadDir: "off" }),
			gateway("no-dir"),
			gateway("duplicate", { downloadDir: "gw" }),
		]);

		expect(dirs).toEqual(["dl", "gw"]);
	});

	it("仅读取网关与远程网关共用同一目录时，该目录仍参与配额", () => {
		// 判据按目录集合而非配置来源：只要还被会产生来源的配置使用就参与
		expect(
			quotaDownloadDirs("", [
				gateway("read-only", {
					urlTemplate: "",
					downloadDir: "shared",
				}),
				gateway("remote", { downloadDir: "shared" }),
			]),
		).toEqual(["shared"]);
	});

	it("禁用网关与启用网关共用同一目录时，该目录仍参与配额", () => {
		expect(
			quotaDownloadDirs("", [
				gateway("off", { enabled: false, downloadDir: "shared" }),
				gateway("remote", { downloadDir: "shared" }),
			]),
		).toEqual(["shared"]);
	});

	it("去重并忽略空目录", () => {
		expect(
			quotaDownloadDirs("", [
				gateway("a", { downloadDir: "" }),
				gateway("b", { downloadDir: "" }),
			]),
		).toEqual([]);
	});
});

describe("selectLandingDir 落盘目录选择", () => {
	it("有网关配置时优先网关目录，依次回退全局下载目录与主存储目录", () => {
		expect(selectLandingDir({ downloadDir: "gw" }, "dl", "cas")).toBe("gw");
		expect(selectLandingDir({}, "dl", "cas")).toBe("dl");
		expect(selectLandingDir(undefined, "dl", "cas")).toBe("dl");
	});

	it("无网关可用目录时回退到主存储目录", () => {
		expect(selectLandingDir({ downloadDir: "" }, "", "cas")).toBe("cas");
		expect(selectLandingDir(undefined, "", "cas")).toBe("cas");
	});
});

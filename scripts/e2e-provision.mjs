/**
 * 装配一次性 Obsidian E2E 环境：vault、user-data、插件文件与预处理脚本产物。
 *
 * 与桌面端 debug-obsidian-plugin skill 的 bootstrap 等价，供 CI workflow 调用
 * （本地验证也可复用）。测试脚本（tests/e2e）只连接 CDP 并断言，不感知环境如何装配。
 *
 * 用法:
 *   node scripts/e2e-provision.mjs --vault <dir> --user-data <dir>
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values: args } = parseArgs({
	options: {
		vault: { type: "string" },
		"user-data": { type: "string" },
	},
});

if (!args.vault || !args["user-data"]) {
	throw new Error(
		"用法: node scripts/e2e-provision.mjs --vault <dir> --user-data <dir>",
	);
}

const pluginId = JSON.parse(
	readFileSync(path.join(root, "manifest.json"), "utf8"),
).id;

// 构建产物缺失时直接失败，避免带着残缺环境启动 Obsidian 后报出难以定位的错误
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(path.join(root, file))) {
		throw new Error(`缺少构建产物 ${file}，请先运行 pnpm run build`);
	}
}
const preprocessSrc = path.join(root, "dist", "preprocess-scripts");
if (!existsSync(preprocessSrc)) {
	throw new Error(
		"缺少 dist/preprocess-scripts，请先运行 pnpm run preprocess:build",
	);
}

const vaultDir = path.resolve(args.vault);
const userDataDir = path.resolve(args["user-data"]);
const obsidianDir = path.join(vaultDir, ".obsidian");
const pluginDir = path.join(obsidianDir, "plugins", pluginId);

mkdirSync(pluginDir, { recursive: true });
mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
mkdirSync(userDataDir, { recursive: true });

// 核心插件启用清单与受限模式开关（与桌面端 skill bootstrap 一致）
const corePlugins = {
	"file-explorer": true,
	search: true,
	bookmarks: true,
	backlink: true,
	"outgoing-link": true,
	"tag-pane": true,
	"page-preview": true,
	"daily-notes": true,
	"random-note": true,
	"word-count": true,
	outline: true,
	"audio-recorder": true,
	"open-with-default-app": true,
	workspaces: true,
	"command-palette": true,
	starred: true,
	"markdown-importer": true,
	restricted: false,
};
writeFileSync(
	path.join(obsidianDir, "core-plugins.json"),
	`${JSON.stringify(corePlugins, null, "\t")}\n`,
);

// 启用列表里放上被测插件，配合受限模式开关/信任流程完成启用
writeFileSync(
	path.join(obsidianDir, "community-plugins.json"),
	`${JSON.stringify([pluginId], null, "\t")}\n`,
);

// user-data 的 obsidian.json：注册 vault 并要求自动打开；
// vault key 与桌面端一致（vault 路径小写后取 MD5 前 16 位十六进制）
const vaultKey = createHash("md5")
	.update(vaultDir.toLowerCase(), "utf8")
	.digest("hex")
	.slice(0, 16);
writeFileSync(
	path.join(userDataDir, "obsidian.json"),
	`${JSON.stringify(
		{
			vaults: {
				[vaultKey]: { path: vaultDir, ts: Date.now(), open: true },
			},
			cli: false,
			updateDisabled: true,
		},
		null,
		"\t",
	)}\n`,
);

// 插件文件：main.js/manifest.json/styles.css 均为构建必产物，缺失已在上方失败
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(path.join(root, file), path.join(pluginDir, file));
}
cpSync(preprocessSrc, path.join(pluginDir, "dist", "preprocess-scripts"), {
	recursive: true,
});

console.log(`vault: ${vaultDir}`);
console.log(`user-data: ${userDataDir}`);
console.log(`plugin: ${pluginDir}`);

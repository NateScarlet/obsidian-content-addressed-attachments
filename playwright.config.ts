import { defineConfig } from "@playwright/test";

// Obsidian E2E：测试脚本只负责连接一个已由环境（桌面端用 debug-obsidian-plugin skill，
// CI 用其自身的 workflow）启动的 Obsidian 实例，并在其 CDP 端口上运行预处理转码断言。
// 连接端点默认 127.0.0.1:9222，可用 OBSIDIAN_CDP_PORT 覆盖。
export default defineConfig({
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	timeout: 120_000,
	use: {
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "e2e",
			testDir: "./tests/e2e",
		},
	],
});

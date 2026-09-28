/**
 * 在已启动的 Obsidian 实例（CDP）上完成「社区插件信任 + 启用被测插件」，
 * 并校验插件确实加载完成。属于环境装配步骤：
 * - CI：.github/workflows/e2e.yml 在启动实例后调用本脚本；
 * - 桌面端：由 debug-obsidian-plugin skill 的 debug.js 承担同等职责。
 *
 * 测试脚本（tests/e2e）只连接 CDP 并断言，不感知环境如何装配。
 *
 * 用法:
 *   node scripts/e2e-enable-plugin.mjs
 * 环境变量:
 *   OBSIDIAN_CDP_PORT  CDP 端口，默认 9222
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginId = JSON.parse(
	readFileSync(path.join(root, "manifest.json"), "utf8"),
).id;

const port = process.env.OBSIDIAN_CDP_PORT ?? "9222";
const connectTimeoutMs = 120_000;
const findPageTimeoutMs = 60_000;
const setupBudgetMs = 60_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry() {
	const deadline = Date.now() + connectTimeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		} catch (error) {
			lastError = error;
			await sleep(500);
		}
	}
	throw new Error(
		`CDP 端口 ${port} 在 ${connectTimeoutMs / 1000}s 内未就绪: ${lastError?.message}`,
	);
}

async function findVaultPage(browser) {
	const deadline = Date.now() + findPageTimeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				const hasApp = await page
					.evaluate(() => !!window.app)
					.catch((error) => {
						lastError = error;
						return false;
					});
				if (hasApp) return page;
			}
		}
		await sleep(500);
	}
	const detail = lastError ? `: ${lastError.message}` : "";
	throw new Error(
		`未在 ${findPageTimeoutMs / 1000}s 内找到已初始化（window.app 就绪）的 Obsidian 页面${detail}`,
	);
}

// 在页面内完成信任与启用流程：分阶段推进，任一阶段成功即可结束；
// 失败时返回发生过的关键动作与页面正文摘要，便于在 CI 日志中定位。
async function runSetup(browser) {
	const attempt = (page) =>
		page.evaluate(
			async ({ pluginId, budgetMs }) => {
				const start = Date.now();
				const deadline = start + budgetMs;
				const sleep = (ms) =>
					new Promise((resolve) => setTimeout(resolve, ms));
				const notes = [];
				const loaded = () => !!window.app?.plugins?.plugins?.[pluginId];
				const fail = (reason) => ({
					status: "error",
					reason,
					notes,
					body: (document.body?.innerText ?? "").slice(0, 1000),
				});
				// 启用成功后的统一收尾：加载失败会弹 Plugin failure 通知，此时插件不算可用
				const finish = async () => {
					await sleep(500);
					const notice = document.querySelector(".notice-container");
					if (notice?.textContent.includes("Plugin failure")) {
						return fail("插件加载失败（Plugin failure 通知）");
					}
					return { status: "ok", notes };
				};

				if (!window.app) return fail("window.app 不存在");

				// 阶段 A：点击页面上出现的信任类按钮（匹配集与 debug.js 一致）。
				// 受限模式的确认按钮可能出现在启动弹窗或横幅中。
				const trustKeywords = [
					"信任",
					"turn off",
					"enable community",
					"trust",
				];
				const clickPageTrust = () => {
					for (const btn of document.querySelectorAll("button")) {
						const text = (btn.textContent ?? "")
							.trim()
							.toLowerCase();
						if (!text) continue;
						if (trustKeywords.some((k) => text.includes(k))) {
							btn.click();
							notes.push(
								`阶段A 点击信任按钮: ${text.slice(0, 60)}`,
							);
							return true;
						}
					}
					return false;
				};

				let clickedOnce = false;
				while (
					!loaded() &&
					Date.now() < Math.min(deadline, start + 8000)
				) {
					if (clickPageTrust()) {
						clickedOnce = true;
						await sleep(500);
						continue;
					}
					await sleep(200);
				}

				// 阶段 B：信任点击可能唤起设置模态框，等待其出现后关闭设置，
				// 使后续启用不受模态框遮挡（与 debug.js 行为一致）
				if (!loaded() && clickedOnce) {
					for (
						let i = 0;
						i < 30 && !document.querySelector(".modal-container");
						i++
					) {
						await sleep(200);
					}
					try {
						window.app.setting?.close?.();
						notes.push("阶段B 已关闭设置面板");
					} catch (error) {
						notes.push(`阶段B 关闭设置失败: ${error.message}`);
					}
				}

				// 阶段 C：直接启用（受限模式已由配置关闭时此步即可成功）
				const tryEnable = async (stage) => {
					if (loaded()) return true;
					try {
						if (window.app.plugins.loadManifests) {
							await window.app.plugins.loadManifests();
						}
						await window.app.plugins.enablePlugin(pluginId);
					} catch (error) {
						notes.push(
							`${stage} enablePlugin 失败: ${error.message}`,
						);
						return false;
					}
					await sleep(300);
					return loaded();
				};

				if (await tryEnable("阶段C")) return finish();

				// 阶段 D：兜底走文档路径 —— 设置 → 社区插件 → 关闭受限模式
				notes.push("阶段D 打开设置页兜底");
				try {
					window.app.setting.open();
					await sleep(500);
					const tabs = [
						...document.querySelectorAll(".vertical-tab-nav-item"),
					];
					const tab = tabs.find((t) =>
						/community plugin|社区插件/i.test(t.textContent ?? ""),
					);
					if (tab) {
						tab.click();
						notes.push("阶段D 已打开社区插件页");
					} else {
						notes.push(
							`阶段D 未找到社区插件标签: ${tabs
								.map((t) => (t.textContent ?? "").trim())
								.filter(Boolean)
								.slice(0, 20)
								.join("|")}`,
						);
					}
					await sleep(500);
					const scope =
						document.querySelector(".modal-container") ?? document;
					const buttons = [...scope.querySelectorAll("button")];
					const toggle = buttons.find((b) =>
						/turn on community plugin|restricted mode|enable community|trust|启用社区插件|受限模式|信任/i.test(
							b.textContent ?? "",
						),
					);
					if (toggle) {
						toggle.click();
						notes.push(
							`阶段D 点击受限模式开关: ${(toggle.textContent ?? "").trim().slice(0, 60)}`,
						);
					} else {
						notes.push(
							`阶段D 未找到受限模式开关: ${buttons
								.map((b) => (b.textContent ?? "").trim())
								.filter(Boolean)
								.slice(0, 20)
								.join("|")}`,
						);
					}
					await sleep(1000);
					try {
						window.app.setting.close();
					} catch (error) {
						notes.push(`阶段D 关闭设置异常: ${error.message}`);
					}
				} catch (error) {
					notes.push(`阶段D 设置页兜底失败: ${error.message}`);
				}

				// 阶段 E：再试一次启用并校验
				if (await tryEnable("阶段E")) return finish();
				return fail(`插件 ${pluginId} 未加载`);
			},
			{ pluginId, budgetMs: setupBudgetMs },
		);

	// 信任开关可能触发页面重载，执行上下文销毁时重连页面再试一次
	let result;
	let lastError;
	for (let i = 0; i < 3; i++) {
		try {
			const page = await findVaultPage(browser);
			result = await attempt(page);
			break;
		} catch (error) {
			lastError = error;
			const retriable =
				/Execution context (was )?destroyed|Target (page )?closed|frame was detached/i.test(
					error.message,
				);
			if (!retriable) throw error;
			console.log(
				`页面执行上下文被销毁，重试（${i + 1}）: ${error.message}`,
			);
			await sleep(1000);
		}
	}
	if (!result) {
		throw new Error(`页面内流程异常终止: ${lastError?.message}`);
	}
	return result;
}

async function main() {
	const browser = await connectWithRetry();
	try {
		const result = await runSetup(browser);
		if (result.status !== "ok") {
			for (const note of result.notes ?? []) console.error(note);
			console.error(`--- 页面正文摘要 ---\n${result.body ?? ""}`);
			throw new Error(
				`插件启用失败: ${result.reason ?? "未知原因"}（详见上方日志）`,
			);
		}
		for (const note of result.notes ?? []) console.log(note);
		console.log(`插件已启用并通过加载校验: ${pluginId}`);
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});

import {
	test,
	expect,
	type Browser,
	type Page,
	chromium,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

const fixturesDir = path.resolve("./tests/e2e-vault/fixtures");
const PLUGIN_ID = "content-addressed-attachments";
const SCRIPT_DIR =
	".obsidian/plugins/content-addressed-attachments/preprocess-scripts/imagemagick.js";
const NOTE_PATH = "e2e.md";

interface Fixture {
	name: string;
	mime: string;
	bytes: Uint8Array;
}

function readFixture(name: string): Fixture {
	const bytes = readFileSync(path.join(fixturesDir, name));
	const mime = name.endsWith(".heic") ? "image/heic" : "image/png";
	return { name, mime, bytes: new Uint8Array(bytes) };
}

// 连接环境已启动的 Obsidian 实例，返回可驱动的渲染进程页面。
// 测试本身不负责启动/装配环境——那是 debug-obsidian-plugin skill（桌面）或
// CI workflow（Actions）的职责。
async function connectObsidian(): Promise<{ browser: Browser; page: Page }> {
	const port = process.env.OBSIDIAN_CDP_PORT ?? "9222";
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			const hasPlugin = await page
				.evaluate(
					(pid) =>
						!!(window as any)?.app?.plugins?.plugins?.[pid],
					PLUGIN_ID,
				)
				.catch(() => false);
			if (hasPlugin) return { browser, page };
		}
	}

	await browser.close();
	throw new Error(
		`未在 CDP 端口 ${port} 找到加载了插件 ${PLUGIN_ID} 的 Obsidian 页面，请先用 debug-obsidian-plugin skill 启动实例`,
	);
}

// 在编辑器打开的空 note 中执行插入命令，轮询等待链接写回后返回 editor 当前内容。
// 插入是异步的（落盘 + CID 计算），因此不能立即读取；每次测试清空 note，
// 保证返回内容里的首条链接就是本次插入的产物。
async function insertFixture(
	page: Page,
	fixture: Fixture,
	scriptURL: string,
): Promise<string> {
	return page.evaluate(
		async ({ scriptURL, fileName, mime, base64 }) => {
			const obsidianApp = (window as any).app;
			const plugin =
				obsidianApp.plugins.plugins["content-addressed-attachments"];

			// 确保 note 存在并以 source 模式打开（reading 模式下 editor 为空）
			const note =
				(await obsidianApp.vault.getFileByPath("e2e.md")) ||
				(await obsidianApp.vault.create("e2e.md", ""));
			await obsidianApp.vault.modify(note, "");
			const leaf = obsidianApp.workspace.getLeaf(true);
			await leaf.setViewState({
				type: "markdown",
				state: { file: note, mode: "source" },
			});
			await obsidianApp.workspace.setActiveLeaf(leaf);

			// 设置预处理脚本（空字符串 = 跳过，保留原始文件）
			plugin.settings.preProcess.scriptURL = scriptURL;
			await plugin.saveSettings();

			const binary = atob(base64);
			const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
			(globalThis as any).showOpenFilePicker = async () => [
				{
					getFile: async () =>
						new File([bytes], fileName, { type: mime }),
				},
			];

			await obsidianApp.commands.executeCommandById(
				"content-addressed-attachments:insert-attachment",
			);

			// 轮询等待链接写进编辑器
			const deadline = Date.now() + 15000;
			const readEditor = () => {
				const editor = leaf?.view?.editor;
				return editor?.getValue?.() ?? "";
			};
			while (Date.now() < deadline) {
				const value = readEditor();
				if (/\]\(ipfs:\/\/bafk[a-z2-7]+/.test(value)) return value;
				await new Promise((r) => setTimeout(r, 50));
			}
			return readEditor();
		},
		{
			scriptURL,
			fileName: fixture.name,
			mime: fixture.mime,
			base64: Buffer.from(fixture.bytes).toString("base64"),
		},
	);
}

function parseLink(content: string): { cid: string; format: string; filename: string } {
	const match = content.match(/!\[([^\]]*)\]\(ipfs:\/\/(bafk[a-z2-7]+)[^)]*\)/);
	expect(match, `note 中应存在图片链接:\n${content}`).toBeTruthy();
	const filename = match![1];
	const cid = match![2];
	const formatMatch = content.match(
		new RegExp(`ipfs://${cid}\\?[^)]*format=([^&)]+)`),
	);
	return { cid, filename, format: decodeURIComponent(formatMatch?.[1] ?? "") };
}

// 由 cid 派生 CAS 相对路径（与 src/infrastructure/local/CASImpl.ts formatRelPath 一致）
function relPathForCID(cid: CID): string {
	const h = cid.toString(base32upper).slice(1);
	const shard = h.slice(h.length - 3, h.length - 1);
	return `${shard}/${h}.data`;
}

async function readCASBytes(page: Page, cid: CID): Promise<Uint8Array> {
	const rel = relPathForCID(cid);
	const base64: string = await page.evaluate(
		async ({ dir, rel }) => {
			const adapter = (window as any).app.vault.adapter;
			const ab = await adapter.readBinary(`${dir}/${rel}`);
			const bytes = new Uint8Array(ab);
			let bin = "";
			for (const b of bytes) bin += String.fromCharCode(b);
			return btoa(bin);
		},
		{ dir: ".attachments/cas", rel },
	);
	return new Uint8Array(Buffer.from(base64, "base64"));
}

async function computeCID(bytes: Uint8Array): Promise<CID> {
	const hash = await sha256.digest(bytes);
	return CID.create(1, raw.code, hash);
}

function assertWebP(bytes: Uint8Array): void {
	const head = Buffer.from(bytes.slice(0, 12)).toString("latin1");
	expect(head.startsWith("RIFF"), `应为 WebP，实际头部: ${head}`).toBe(true);
	expect(head.includes("WEBP"), `应为 WebP，实际头部: ${head}`).toBe(true);
}

function assertAVIF(bytes: Uint8Array): void {
	const head = Buffer.from(bytes.slice(4, 12)).toString("latin1");
	expect(head, `应为 AVIF (ftyp avif)，实际头部: ${head}`).toBe("ftypavif");
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
	({ browser, page } = await connectObsidian());
});

test.afterAll(async () => {
	await browser.close();
});

test("preserves the original attachment without a preprocess script", async () => {
	const fixture = readFixture("sample.png");
	const content = await insertFixture(page, fixture, "");

	const { cid, format, filename } = parseLink(content);
	expect(format).toBe("image/png");
	expect(filename).toBe("sample.png");

	const casBytes = await readCASBytes(page, CID.parse(cid));
	expect(Buffer.from(casBytes).equals(Buffer.from(fixture.bytes))).toBe(true);
	expect(CID.parse(cid).equals(await computeCID(casBytes))).toBe(true);
});

test("converts a HEIC input to WebP via the preprocess script", async () => {
	const fixture = readFixture("sample.heic");
	const content = await insertFixture(
		page,
		fixture,
		`${SCRIPT_DIR}#format=webp&quality=45`,
	);

	const { cid, format, filename } = parseLink(content);
	expect(format).toBe("image/webp");
	expect(filename).toBe("sample.webp");
	expect(cid).not.toBe((await computeCID(fixture.bytes)).toString());

	const casBytes = await readCASBytes(page, CID.parse(cid));
	assertWebP(casBytes);
	expect(CID.parse(cid).equals(await computeCID(casBytes))).toBe(true);
});

test("converts a HEIC input to AVIF via the preprocess script", async () => {
	const fixture = readFixture("sample.heic");
	const content = await insertFixture(
		page,
		fixture,
		`${SCRIPT_DIR}#format=avif&quality=45`,
	);

	const { cid, format, filename } = parseLink(content);
	expect(format).toBe("image/avif");
	expect(filename).toBe("sample.avif");

	const casBytes = await readCASBytes(page, CID.parse(cid));
	assertAVIF(casBytes);
	expect(CID.parse(cid).equals(await computeCID(casBytes))).toBe(true);
});
// @vitest-environment happy-dom
/* eslint-disable obsidianmd/prefer-active-doc -- 测试刻意注入独立 document，不访问 Obsidian 全局 activeDocument */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageLinkPatcher from "./PageLinkPatcher";
import type { ResolveURLResult } from "./URLResolver";
import type { FailureImageSource } from "./utils/FailureImages";
import type { PatchFailureReporter } from "./PageLinkPatcher";

function resolvedURL(url: string): ResolveURLResult {
	return { url, cid: {} as ResolveURLResult["cid"] };
}

function imageWithSrc(src: string): HTMLImageElement {
	const img = document.createElement("img");
	img.setAttribute("src", src);
	return img;
}

function createDeps(resolveURL = vi.fn()) {
	return {
		resolveURL,
		notice: { report: vi.fn() } satisfies PatchFailureReporter,
		failures: {
			notFound: "blob:notfound",
			forError: vi.fn(() => "blob:failure"),
		} satisfies FailureImageSource,
		placeholder: "blob:placeholder",
		document,
	};
}

describe("PageLinkPatcher", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("start() 扫描初始页面中的 ipfs 链接并写回解析结果", async () => {
		const img = imageWithSrc("ipfs://x");
		document.body.appendChild(img);
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/a.png")),
		);
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.resolveURL).toHaveBeenCalledWith("ipfs://x"),
		);
		await vi.waitFor(() =>
			expect(img.getAttribute("src")).toBe("app://local/a.png"),
		);
		expect(img.getAttribute("data-original-src")).toBe("ipfs://x");
		patcher.dispose();
	});

	it("剥离 http:/// 伪装前缀后再解析", async () => {
		document.body.appendChild(imageWithSrc("http:///ipfs://wrapped"));
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/wrapped.png")),
		);
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.resolveURL).toHaveBeenCalledWith("ipfs://wrapped"),
		);
		patcher.dispose();
	});

	it("补丁 Base 卡片封面的伪装背景图", async () => {
		const div = document.createElement("div");
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment -- 构造测试 fixture 中的伪装背景图
		div.style.backgroundImage = 'url("http:///ipfs://bg")';
		document.body.appendChild(div);
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/bg.png")),
		);
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.resolveURL).toHaveBeenCalledWith("ipfs://bg"),
		);
		await vi.waitFor(() =>
			expect(div.style.backgroundImage).toBe('url("app://local/bg.png")'),
		);
		patcher.dispose();
	});

	it("start() 后新增的节点会被 observer 补丁", async () => {
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/added.png")),
		);
		const patcher = new PageLinkPatcher(deps);
		patcher.start();
		await vi.waitFor(() => expect(deps.resolveURL).not.toHaveBeenCalled());

		const img = imageWithSrc("ipfs://added");
		document.body.appendChild(img);

		await vi.waitFor(() =>
			expect(deps.resolveURL).toHaveBeenCalledWith("ipfs://added"),
		);
		await vi.waitFor(() =>
			expect(img.getAttribute("src")).toBe("app://local/added.png"),
		);
		patcher.dispose();
	});

	it("元素级失败被隔离并只上报一次累计失败数", async () => {
		document.body.appendChild(imageWithSrc("ipfs://a"));
		document.body.appendChild(imageWithSrc("ipfs://b"));
		const deps = createDeps(vi.fn().mockRejectedValue(new Error("boom")));
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.notice.report).toHaveBeenCalledWith(2),
		);
		expect(deps.notice.report).toHaveBeenCalledTimes(1);
		// 失败图已写入，元素没有停在加载态
		for (const img of document.body.querySelectorAll("img")) {
			expect(img.getAttribute("src")).toBe("blob:failure");
		}
		patcher.dispose();
	});

	it("一个元素解析失败不影响同批其他元素", async () => {
		document.body.appendChild(imageWithSrc("ipfs://bad"));
		const good = imageWithSrc("ipfs://good");
		document.body.appendChild(good);
		const deps = createDeps(
			vi.fn((rawURL: string) =>
				rawURL === "ipfs://bad"
					? Promise.reject(new Error("boom"))
					: Promise.resolve(resolvedURL("app://local/good.png")),
			),
		);
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.notice.report).toHaveBeenCalledWith(1),
		);
		expect(good.getAttribute("src")).toBe("app://local/good.png");
		patcher.dispose();
	});

	it("同一元素同时命中链接与背景图选择器时只处理一次", async () => {
		const el = document.createElement("div");
		el.setAttribute("src", "ipfs://both");
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment -- 构造测试 fixture 中的伪装背景图
		el.style.backgroundImage = 'url("http:///ipfs://bg")';
		document.body.appendChild(el);
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/both.png")),
		);
		const patcher = new PageLinkPatcher(deps);

		patcher.start();

		await vi.waitFor(() =>
			expect(deps.resolveURL).toHaveBeenCalledWith("ipfs://both"),
		);
		expect(deps.resolveURL).toHaveBeenCalledTimes(1);
		patcher.dispose();
	});

	it("非 HTML 元素的变动不作为补丁根", async () => {
		const svg = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		document.body.appendChild(svg);
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/svg.png")),
		);
		const patcher = new PageLinkPatcher(deps);
		patcher.start();
		await vi.waitFor(() => expect(deps.resolveURL).not.toHaveBeenCalled());

		const image = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"image",
		);
		image.setAttribute("href", "ipfs://svg");
		svg.appendChild(image);
		await new Promise((resolve) => window.setTimeout(resolve, 20));

		expect(deps.resolveURL).not.toHaveBeenCalled();
		patcher.dispose();
	});

	it("dispose() 后 observer 断开，新增节点不再被补丁", async () => {
		const deps = createDeps(
			vi.fn().mockResolvedValue(resolvedURL("app://local/after.png")),
		);
		const patcher = new PageLinkPatcher(deps);
		patcher.start();
		patcher.dispose();

		document.body.appendChild(imageWithSrc("ipfs://after-dispose"));
		await new Promise((resolve) => window.setTimeout(resolve, 20));

		expect(deps.resolveURL).not.toHaveBeenCalled();
	});
});

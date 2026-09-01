import { describe, it, expect, vi } from "vitest";
import patchElementURL, {
	patchElementBackgroundImage,
} from "./patchElementURLs";
import type { ResolveURLResult } from "../URLResolver";
import { formatBackgroundImage } from "./wrappedBackgroundImage";

const placeholderURL = "blob:placeholder";
const notFoundURL = "blob:notfound";

/** 模拟最小 HTMLElement 属性读写，避免依赖 DOM 测试环境 */
function createFakeElement(attrs: Record<string, string>) {
	const map = new Map(Object.entries(attrs));
	return {
		getAttribute: (name: string) => map.get(name) ?? null,
		setAttribute: (name: string, value: string) =>
			void map.set(name, value),
	};
}

/** 模拟 Base 卡片背景图元素的最小结构 */
function createFakeBgElement(backgroundImage: string) {
	return { style: { backgroundImage } };
}

function resolvedURL(url: string): ResolveURLResult {
	return { url, cid: {} as ResolveURLResult["cid"] };
}

function pendingResolve() {
	let release!: (v: ResolveURLResult | undefined) => void;
	const resolve = vi.fn<() => Promise<ResolveURLResult | undefined>>(
		() => new Promise((res) => (release = res)),
	);
	return {
		resolve,
		// 用 getter 在访问时取最新值：impl 首次执行时才给 release 赋值
		get releaseResolve() {
			return release;
		},
	};
}

function releaseResolved(
	pending: ReturnType<typeof pendingResolve>,
	url: string,
) {
	pending.releaseResolve?.(resolvedURL(url));
}

describe("patchElementURL", () => {
	it("为 img 的 src 设占位图，解析成功后写入资源 URL 并记录原值", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/a.png"));

		await patchElementURL(el, "src", resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe("app://local/a.png");
		expect(el.getAttribute("data-original-src")).toBe("ipfs://x");
		expect(resolve).toHaveBeenCalledWith("ipfs://x");
	});

	it("解析返回 undefined 时，img 的 src 写入 notFound 图", async () => {
		const el = createFakeElement({ src: "ipfs://x" });

		await patchElementURL(el, "src", vi.fn().mockResolvedValue(undefined), {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe(notFoundURL);
	});

	it("解析返回 undefined 时，非 fallback 属性保持原值", async () => {
		const el = createFakeElement({ href: "ipfs://x" });

		await patchElementURL(
			el,
			"href",
			vi.fn().mockResolvedValue(undefined),
			{
				imageFallback: false,
				placeholderImageURL: placeholderURL,
				notFoundImageURL: notFoundURL,
			},
		);

		expect(el.getAttribute("href")).toBe("ipfs://x");
	});

	it("异步解析期间 img 的 src 被组件改掉后，不覆盖组件修改", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		// 不 await，让异步解析进行到挂起状态
		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});
		// 占位图已写入，说明已进入挂起
		expect(el.getAttribute("src")).toBe(placeholderURL);

		// 组件在解析期间把自己的内容写进 src
		const userSrc = "app://local/user-modified.png";
		el.setAttribute("src", userSrc);

		releaseResolved(p, "app://local/resolved.png");
		await pending;

		expect(el.getAttribute("src")).toBe(userSrc);
		// 未覆盖时也不应记录原值（避免留下虚假的 data-original）
		expect(el.getAttribute("data-original-src")).toBeNull();
	});

	it("异步解析期间 href 被组件改掉后，不覆盖组件修改", async () => {
		const el = createFakeElement({ href: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "href", p.resolve, {
			imageFallback: false,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});
		// href 无占位图阶段，等待解析被调用进入挂起
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());

		const userHref = "app://local/user-modified";
		el.setAttribute("href", userHref);

		releaseResolved(p, "app://local/resolved");
		await pending;

		expect(el.getAttribute("href")).toBe(userHref);
	});

	// 新增测试：http:/// 伪装前缀支持
	it("支持 http:///ipfs:// 伪装前缀的 img src", async () => {
		const el = createFakeElement({ src: "http:///ipfs://x" });
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/a.png"));

		await patchElementURL(el, "src", resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe("app://local/a.png");
		expect(el.getAttribute("data-original-src")).toBe("ipfs://x");
		expect(resolve).toHaveBeenCalledWith("ipfs://x");
	});

	it("支持 http:///internal.ipfs-locked: 伪装前缀的 img src", async () => {
		const lockedURL =
			"internal.ipfs-locked:bafybei...,https://example.com/x.png";
		const el = createFakeElement({ src: `http:///${lockedURL}` });
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/a.png"));

		await patchElementURL(el, "src", resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe("app://local/a.png");
		expect(el.getAttribute("data-original-src")).toBe(lockedURL);
		expect(resolve).toHaveBeenCalledWith(lockedURL);
	});

	it("http:/// 伪装前缀但内容不是 IPFS 链接时跳过", async () => {
		const el = createFakeElement({
			src: "http:///https://example.com/x.png",
		});
		const resolve = vi.fn();

		await patchElementURL(el, "src", resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe(
			"http:///https://example.com/x.png",
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("http:/// 伪装前缀的 img 在解析失败时正确显示 notFound", async () => {
		const el = createFakeElement({ src: "http:///ipfs://x" });

		await patchElementURL(el, "src", vi.fn().mockResolvedValue(undefined), {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("src")).toBe(notFoundURL);
	});

	it("http:/// 伪装前缀的 img 在等待期间被修改时竞态保护生效", async () => {
		const el = createFakeElement({ src: "http:///ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});
		expect(el.getAttribute("src")).toBe(placeholderURL);

		const userSrc = "app://local/user-modified.png";
		el.setAttribute("src", userSrc);

		releaseResolved(p, "app://local/resolved.png");
		await pending;

		expect(el.getAttribute("src")).toBe(userSrc);
		expect(el.getAttribute("data-original-src")).toBeNull();
	});

	it("纯文本 http:/// 伪装前缀的 href 在解析成功时不写占位图（非 imageFallback）", async () => {
		const el = createFakeElement({ href: "http:///ipfs://x" });
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/a.txt"));

		await patchElementURL(el, "href", resolve, {
			imageFallback: false,
			placeholderImageURL: placeholderURL,
			notFoundImageURL: notFoundURL,
		});

		expect(el.getAttribute("href")).toBe("app://local/a.txt");
		expect(el.getAttribute("data-original-href")).toBe("ipfs://x");
		expect(resolve).toHaveBeenCalledWith("ipfs://x");
	});
});

describe("patchElementBackgroundImage", () => {
	it("解析成功后写入格式化背景图", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/bg.png"));

		await patchElementBackgroundImage(el, resolve);

		expect(el.style.backgroundImage).toBe('url("app://local/bg.png")');
	});

	it("解析失败时保持原伪装背景图不变", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');

		await patchElementBackgroundImage(
			el,
			vi.fn().mockResolvedValue(undefined),
		);

		expect(el.style.backgroundImage).toBe('url("http:///ipfs://x")');
	});

	it("异步解析期间背景图被组件改掉后，不覆盖组件修改", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve);
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());

		// 组件在解析期间把背景图改成自己的内容
		const userBgImage = formatBackgroundImage("app://local/user-bg.png");
		el.style.backgroundImage = userBgImage;

		releaseResolved(p, "app://local/resolved.png");
		await pending;

		expect(el.style.backgroundImage).toBe(userBgImage);
	});
});

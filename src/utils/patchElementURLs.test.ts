import { describe, it, expect, vi } from "vitest";
import patchElementURL from "./patchElementURLs";
import patchElementBackgroundImage from "./patchElementBackgroundImage";
import type { ResolveURLResult } from "../URLResolver";
import { formatBackgroundImage } from "./wrappedBackgroundImage";
import { InvalidContentIDError } from "../ResolveURLError";
import type { FailureImageSource } from "./FailureImages";

const placeholderURL = "blob:placeholder";
const notFoundURL = "blob:notfound";
const failureURL = "blob:failure";

/** 失败图来源替身：记录收到的错误，便于断言展示层按错误对象取图 */
function createFailures() {
	const forError = vi.fn((_error: unknown) => failureURL);
	return { notFound: notFoundURL, forError } satisfies FailureImageSource & {
		forError: typeof forError;
	};
}

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
	const attrs = new Map<string, string>();
	return {
		style: { backgroundImage },
		setAttribute: (name: string, value: string) =>
			void attrs.set(name, value),
		getAttribute: (name: string) => attrs.get(name) ?? null,
	};
}

function resolvedURL(url: string): ResolveURLResult {
	return { url, cid: {} as ResolveURLResult["cid"] };
}

function pendingResolve() {
	let release!: (v: ResolveURLResult | undefined) => void;
	let reject!: (error: unknown) => void;
	const resolve = vi.fn<() => Promise<ResolveURLResult | undefined>>(
		() =>
			new Promise((res, rej) => {
				release = res;
				reject = rej;
			}),
	);
	return {
		resolve,
		// 用 getter 在访问时取最新值：impl 首次执行时才给 release 赋值
		get releaseResolve() {
			return release;
		},
		get rejectResolve() {
			return reject;
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
			placeholder: placeholderURL,
			failures: createFailures(),
		});

		expect(el.getAttribute("src")).toBe("app://local/a.png");
		expect(el.getAttribute("data-original-src")).toBe("ipfs://x");
		expect(resolve).toHaveBeenCalledWith("ipfs://x");
	});

	it("解析返回 undefined 时，img 的 src 写入 notFound 图", async () => {
		const el = createFakeElement({ src: "ipfs://x" });

		await patchElementURL(el, "src", vi.fn().mockResolvedValue(undefined), {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});

		expect(el.getAttribute("src")).toBe(notFoundURL);
	});

	it("解析抛错时，img 的 src 写入错误对应的失败图", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const failures = createFailures();
		const error = new InvalidContentIDError("ipfs://x");

		await patchElementURL(el, "src", vi.fn().mockRejectedValue(error), {
			imageFallback: true,
			placeholder: placeholderURL,
			failures,
		});

		expect(el.getAttribute("src")).toBe(failureURL);
		expect(failures.forError).toHaveBeenCalledWith(error);
	});

	it("解析抛错且错误不是自定义类型时，写入通用失败图并继续向上抛出", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const failures = createFailures();
		const error = new Error("unexpected");

		await expect(
			patchElementURL(el, "src", vi.fn().mockRejectedValue(error), {
				imageFallback: true,
				placeholder: placeholderURL,
				failures,
			}),
		).rejects.toBe(error);

		// 仍写入通用失败图，避免元素停在加载态
		expect(el.getAttribute("src")).toBe(failureURL);
		expect(failures.forError).toHaveBeenCalledWith(error);
	});

	it("解析返回 undefined 时，非 fallback 属性保持原值", async () => {
		const el = createFakeElement({ href: "ipfs://x" });

		await patchElementURL(
			el,
			"href",
			vi.fn().mockResolvedValue(undefined),
			{
				imageFallback: false,
				placeholder: placeholderURL,
				failures: createFailures(),
			},
		);

		expect(el.getAttribute("href")).toBe("ipfs://x");
	});

	it("解析抛错时，非 fallback 属性保持原值", async () => {
		const el = createFakeElement({ href: "ipfs://x" });

		await patchElementURL(
			el,
			"href",
			vi.fn().mockRejectedValue(new InvalidContentIDError("ipfs://x")),
			{
				imageFallback: false,
				placeholder: placeholderURL,
				failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
		});

		expect(el.getAttribute("src")).toBe(notFoundURL);
	});

	it("http:/// 伪装前缀的 img 在等待期间被修改时竞态保护生效", async () => {
		const el = createFakeElement({ src: "http:///ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
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
			placeholder: placeholderURL,
			failures: createFailures(),
		});

		expect(el.getAttribute("href")).toBe("app://local/a.txt");
		expect(el.getAttribute("data-original-href")).toBe("ipfs://x");
		expect(resolve).toHaveBeenCalledWith("ipfs://x");
	});

	// #region 失败写入规则（issue #53）

	it("解析期间 src 被清空时，解析失败仍写入失败图", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		el.setAttribute("src", "");

		p.rejectResolve?.(new InvalidContentIDError("ipfs://x"));
		await pending;

		expect(el.getAttribute("src")).toBe(failureURL);
	});

	it("解析期间 src 被外部写入另一个有效值时，解析失败不覆盖该值", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		const externalSrc = "app://local/external.png";
		el.setAttribute("src", externalSrc);

		p.rejectResolve?.(new InvalidContentIDError("ipfs://x"));
		await pending;

		expect(el.getAttribute("src")).toBe(externalSrc);
	});

	it("解析期间 src 被回写成原始值时，解析失败仍写入失败图", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		el.setAttribute("src", "ipfs://x");

		p.rejectResolve?.(new InvalidContentIDError("ipfs://x"));
		await pending;

		expect(el.getAttribute("src")).toBe(failureURL);
	});

	it("解析无结果时同样遵循失败写入规则：src 被清空则写入 notFound", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		el.setAttribute("src", "");

		p.releaseResolve?.(undefined);
		await pending;

		expect(el.getAttribute("src")).toBe(notFoundURL);
	});

	it("解析无结果时同样遵循失败写入规则：外部写入有效值则保留", async () => {
		const el = createFakeElement({ src: "ipfs://x" });
		const p = pendingResolve();

		const pending = patchElementURL(el, "src", p.resolve, {
			imageFallback: true,
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		const externalSrc = "app://local/external.png";
		el.setAttribute("src", externalSrc);

		p.releaseResolve?.(undefined);
		await pending;

		expect(el.getAttribute("src")).toBe(externalSrc);
	});

	// #endregion
});

describe("patchElementBackgroundImage", () => {
	it("解析成功：显示占位图 -> 显示解析后的资源 URL", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const resolve = vi
			.fn()
			.mockResolvedValue(resolvedURL("app://local/bg.png"));

		await patchElementBackgroundImage(el, resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage("app://local/bg.png"),
		);
	});

	it("解析失败：显示占位图 -> 显示 notFound 图", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');

		await patchElementBackgroundImage(
			el,
			vi.fn().mockResolvedValue(undefined),
			{
				placeholder: placeholderURL,
				failures: createFailures(),
			},
		);

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(notFoundURL),
		);
	});

	it("解析抛错时写入错误对应的失败图", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const failures = createFailures();
		const error = new InvalidContentIDError("ipfs://x");

		await patchElementBackgroundImage(
			el,
			vi.fn().mockRejectedValue(error),
			{
				placeholder: placeholderURL,
				failures,
			},
		);

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(failureURL),
		);
		expect(failures.forError).toHaveBeenCalledWith(error);
	});

	it("解析抛错且错误不是自定义类型时，写入通用失败图并继续向上抛出", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const failures = createFailures();
		const error = new Error("unexpected");

		await expect(
			patchElementBackgroundImage(el, vi.fn().mockRejectedValue(error), {
				placeholder: placeholderURL,
				failures,
			}),
		).rejects.toBe(error);

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(failureURL),
		);
	});

	it("解析期间显示占位图", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		// 占位图已写入，说明已进入挂起
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(placeholderURL),
		);

		releaseResolved(p, "app://local/resolved.png");
		await pending;

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage("app://local/resolved.png"),
		);
	});

	it("异步解析期间背景图被组件改掉后，不覆盖组件修改", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());

		// 组件在解析期间把背景图改成自己的内容
		const userBgImage = formatBackgroundImage("app://local/user-bg.png");
		el.style.backgroundImage = userBgImage;

		releaseResolved(p, "app://local/resolved.png");
		await pending;

		expect(el.style.backgroundImage).toBe(userBgImage);
	});

	it("解析失败时外部写入了有效背景图则不覆盖", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());

		// 组件在解析期间把背景图改成自己的内容
		const userBgImage = formatBackgroundImage("app://local/user-bg.png");
		el.style.backgroundImage = userBgImage;

		// 释放失败结果
		p.releaseResolve?.(undefined);
		await pending;

		// 应保持组件的修改，不写入 notFound
		expect(el.style.backgroundImage).toBe(userBgImage);
	});

	// #region 失败写入规则（issue #53）

	it("解析期间背景图被清空时，解析失败仍写入失败图", async () => {
		for (const cleared of ["", "none"]) {
			const el = createFakeBgElement('url("http:///ipfs://x")');
			const p = pendingResolve();

			const pending = patchElementBackgroundImage(el, p.resolve, {
				placeholder: placeholderURL,
				failures: createFailures(),
			});
			await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
			el.style.backgroundImage = cleared;

			p.rejectResolve?.(new InvalidContentIDError("ipfs://x"));
			await pending;

			expect(el.style.backgroundImage, `cleared=${cleared}`).toBe(
				formatBackgroundImage(failureURL),
			);
		}
	});

	it("解析期间背景图被回写成原始伪装链接时，解析失败仍写入失败图", async () => {
		const original = 'url("http:///ipfs://x")';
		const el = createFakeBgElement(original);
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		el.style.backgroundImage = original;

		p.rejectResolve?.(new InvalidContentIDError("ipfs://x"));
		await pending;

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(failureURL),
		);
	});

	it("解析无结果时同样遵循失败写入规则：背景图被清空则写入 notFound", async () => {
		const el = createFakeBgElement('url("http:///ipfs://x")');
		const p = pendingResolve();

		const pending = patchElementBackgroundImage(el, p.resolve, {
			placeholder: placeholderURL,
			failures: createFailures(),
		});
		await vi.waitFor(() => expect(p.resolve).toHaveBeenCalled());
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment -- 模拟组件清空背景图
		el.style.backgroundImage = "";

		p.releaseResolve?.(undefined);
		await pending;

		expect(el.style.backgroundImage).toBe(
			formatBackgroundImage(notFoundURL),
		);
	});

	// #endregion
});

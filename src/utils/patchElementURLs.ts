import type { ResolveURLResult } from "../URLResolver";
import { stripWrappedPrefix } from "./wrappedBackgroundImage";

export interface PatchElementURLOptions {
	/** 该属性是否使用占位图/notFound 图（img 元素且属性为 src） */
	imageFallback: boolean;
	/** img 解析期间的占位图 */
	placeholder: string;
	/** img 解析失败时的兜底图 */
	notFound: string;
}

/** 属性补丁所需的最小元素接口，便于替换实现进行测试 */
export interface PatchableElement {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
}

/**
 * 把元素属性中的 ipfs:// 链接补丁为可访问的资源 URL。
 * img 的 src 在解析期间先显示占位图；异步解析返回后，
 * 仅当属性仍是等待态（占位图或初始值）时才写回结果，
 * 避免覆盖等待期间组件自己对属性的修改。
 */
export default async function patchElementURL(
	el: PatchableElement,
	attr: "src" | "href",
	resolveURL: (rawURL: string) => Promise<ResolveURLResult | undefined>,
	options: PatchElementURLOptions,
): Promise<void> {
	const value = el.getAttribute(attr);
	if (!value) {
		return;
	}
	// 剥离 http:/// 伪装前缀（如卡片封面专用格式），使普通 img 也能使用同一份元数据链接
	const canonical = stripWrappedPrefix(value) ?? value;
	if (
		!canonical.startsWith("ipfs://") &&
		!canonical.startsWith("internal.ipfs-locked:")
	) {
		return;
	}
	// img+src 先显示占位图；其余属性保持原值作为等待态
	const waitingValue = options.imageFallback ? options.placeholder : value;
	if (options.imageFallback) {
		el.setAttribute(attr, waitingValue);
	}
	const resolvedURL = await resolveURL(canonical);
	// 竞态保护：等待期间元素属性可能已被组件修改，
	// 仅当属性仍是等待态（占位图或初始值）时才写回解析结果，避免覆盖组件自己的修改
	if (el.getAttribute(attr) !== waitingValue) {
		return;
	}
	if (resolvedURL) {
		el.setAttribute(`data-original-${attr}`, canonical);
		el.setAttribute(attr, resolvedURL.url);
		return;
	}
	if (options.imageFallback) {
		el.setAttribute(attr, options.notFound);
	} else {
		el.setAttribute(attr, value);
	}
}

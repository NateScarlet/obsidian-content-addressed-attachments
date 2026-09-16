import type { ResolveURLResult } from "../URLResolver";
import {
	extractWrappedBackgroundURL,
	formatBackgroundImage,
} from "./wrappedBackgroundImage";

/** 背景图补丁所需的最小元素接口 */
export interface PatchableBackgroundElement {
	style: { backgroundImage: string };
	setAttribute(name: string, value: string): void;
}

/** 背景图回退图片选项（占位图 + 失败兜底图） */
export interface FallbackImages {
	/** 解析期间的占位图 */
	placeholder: string;
	/** 解析失败时的兜底图 */
	notFound: string;
}

/**
 * 把 Base 卡片封面 background-image 中的伪装前缀 IPFS 链接补丁为可访问的资源 URL。
 * 解析期间显示占位图；解析成功写入资源 URL；解析失败显示 notFound 图。
 * 异步解析返回后仅当背景图仍是等待态（占位图）时才写回，
 * 避免覆盖等待期间组件自己对背景图的修改。
 */
export default async function patchElementBackgroundImage(
	el: PatchableBackgroundElement,
	resolveURL: (rawURL: string) => Promise<ResolveURLResult | undefined>,
	options: FallbackImages,
): Promise<void> {
	const canonical = extractWrappedBackgroundURL(el.style.backgroundImage);
	if (!canonical) {
		return;
	}
	// 先显示占位图
	const waitingValue = formatBackgroundImage(options.placeholder);
	el.style.backgroundImage = waitingValue;

	const resolvedURL = await resolveURL(canonical);
	// 竞态保护：等待期间组件可能已改动背景图，仅当仍是等待态（占位图）时才写回
	if (el.style.backgroundImage !== waitingValue) {
		return;
	}
	if (resolvedURL) {
		el.setAttribute("data-original-background-image", canonical);
		el.style.backgroundImage = formatBackgroundImage(resolvedURL.url);
		return;
	}
	// 解析失败：显示 notFound 图
	el.style.backgroundImage = formatBackgroundImage(options.notFound);
}

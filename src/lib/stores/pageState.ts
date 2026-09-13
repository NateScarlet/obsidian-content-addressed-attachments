import type { Mode } from "../CASFileExplorerContext";

/** 页加载状态：以可判别联合取代「布尔标记 + 可选数据」的组合，避免不可达状态 */
export type PageState<T> =
	| { loading: true; page: undefined }
	| { loading: false; page: T };

/**
 * 页结果加载状态判定：页结果打上了生成它的模式标签。
 * - 结果为空，或结果的模式标签与当前模式不一致时，当前页仍处于加载中（显示骨架）。
 * - 仅当结果标签与当前模式一致才视为已就绪，可渲染网格。
 * 用计数枚举比较即可，未导入具体页类型以保持纯函数可测、避免与数据层耦合。
 */
export default function pageState<T extends { mode: Mode }>(
	currentMode: Mode,
	page: T | undefined,
): PageState<T> {
	if (!page || page.mode !== currentMode) {
		return { loading: true, page: undefined };
	}
	return { loading: false, page };
}

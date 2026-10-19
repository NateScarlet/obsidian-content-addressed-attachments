import type { ResolveURLResult } from "../URLResolver";
import type { FailureImageSource } from "./FailureImages";
import {
	attemptResolve,
	failureImageFor,
	rethrowUnexpectedFailure,
	shouldWriteFailure,
} from "./elementPatch";
import {
	extractWrappedBackgroundURL,
	formatBackgroundImage,
} from "./wrappedBackgroundImage";

/** 背景图补丁所需的最小元素接口 */
export interface PatchableBackgroundElement {
	style: { backgroundImage: string };
	setAttribute(name: string, value: string): void;
}

/** 背景图补丁选项 */
export interface BackgroundImagePatchOptions {
	/** 解析期间的占位图 */
	placeholder: string;
	/** 合法缺失与解析失败时使用的失败图 */
	failures: FailureImageSource;
}

/**
 * 把 Base 卡片封面 background-image 中的伪装前缀 IPFS 链接补丁为可访问的资源 URL。
 *
 * 解析期间显示占位图；解析成功时仅当背景图仍是等待态才写回，避免覆盖组件修改；
 * 解析失败时按失败写入规则展示失败图：背景图为空、仍停在等待态或仍是原始值时
 * 写入，外部已写入有效背景图时保留。
 */
export default async function patchElementBackgroundImage(
	el: PatchableBackgroundElement,
	resolveURL: (rawURL: string) => Promise<ResolveURLResult | undefined>,
	options: BackgroundImagePatchOptions,
): Promise<void> {
	const originalValue = el.style.backgroundImage;
	const canonical = extractWrappedBackgroundURL(originalValue);
	if (!canonical) {
		return;
	}
	// 先显示占位图
	const waitingValue = formatBackgroundImage(options.placeholder);
	el.style.backgroundImage = waitingValue;

	const attempt = await attemptResolve(() => resolveURL(canonical));

	if (attempt.status === "resolved") {
		// 竞态保护：等待期间组件可能已改动背景图，仅当仍是等待态时才写回
		if (el.style.backgroundImage !== waitingValue) {
			return;
		}
		el.setAttribute("data-original-background-image", canonical);
		el.style.backgroundImage = formatBackgroundImage(attempt.result.url);
		return;
	}

	if (
		shouldWriteFailure(
			el.style.backgroundImage,
			waitingValue,
			originalValue,
		)
	) {
		el.style.backgroundImage = formatBackgroundImage(
			failureImageFor(attempt, options.failures),
		);
	}

	// 非自定义错误是代码缺陷：失败图已写入，继续向上抛出以便调用方合并成提示
	rethrowUnexpectedFailure(attempt);
}

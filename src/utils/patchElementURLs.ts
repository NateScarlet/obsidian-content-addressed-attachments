import type { ResolveURLResult } from "../URLResolver";
import type { FailureImageSource } from "./FailureImages";
import {
	attemptResolve,
	failureImageFor,
	rethrowUnexpectedFailure,
	shouldWriteFailure,
} from "./elementPatch";
import { stripWrappedPrefix } from "./wrappedBackgroundImage";

export interface PatchElementURLOptions {
	/** 该属性是否使用占位图/失败图（img 元素且属性为 src） */
	imageFallback: boolean;
	/** img 解析期间的占位图 */
	placeholder: string;
	/** 合法缺失与解析失败时使用的失败图 */
	failures: FailureImageSource;
}

/** 属性补丁所需的最小元素接口，便于替换实现进行测试 */
export interface PatchableElement {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
}

/**
 * 把元素属性中的 ipfs:// 链接补丁为可访问的资源 URL。
 *
 * img 的 src 在解析期间先显示占位图；解析成功时仅当属性仍是等待态
 * （占位图或初始值）才写回结果，避免覆盖等待期间组件自己对属性的修改。
 * 解析失败（返回 undefined 或抛错）时按失败写入规则展示失败图：
 * 元素为空、仍停在等待态或仍是原始值时写入，外部已写入有效值时保留。
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

	const attempt = await attemptResolve(() => resolveURL(canonical));

	if (attempt.status === "resolved") {
		// 竞态保护：等待期间元素属性可能已被组件修改，
		// 仅当属性仍是等待态时才写回解析结果，避免覆盖组件自己的修改
		if (el.getAttribute(attr) !== waitingValue) {
			return;
		}
		el.setAttribute(`data-original-${attr}`, canonical);
		el.setAttribute(attr, attempt.result.url);
		return;
	}

	if (options.imageFallback) {
		const current = el.getAttribute(attr);
		if (shouldWriteFailure(current, waitingValue, value)) {
			el.setAttribute(attr, failureImageFor(attempt, options.failures));
		}
	}

	// 非自定义错误是代码缺陷：失败图已写入，继续向上抛出以便调用方合并成提示
	rethrowUnexpectedFailure(attempt);
}

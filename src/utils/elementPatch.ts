import type { ResolveURLResult } from "../URLResolver";
import ResolveURLError from "../ResolveURLError";
import type { FailureImageSource } from "./FailureImages";

/** 元素补丁解析一次链接的结果 */
export type ResolveAttempt =
	| { status: "resolved"; result: ResolveURLResult }
	| { status: "missing" }
	| { status: "failed"; error: unknown };

/** 非成功的解析结果（合法缺失或失败） */
export type UnresolvedAttempt = Exclude<ResolveAttempt, { status: "resolved" }>;

/**
 * 把解析结果与抛错统一成可分支处理的结果。
 * 补丁函数需要区分「合法缺失」「失败」「成功」，且失败后仍要继续写回元素状态。
 */
export async function attemptResolve(
	resolveURL: () => Promise<ResolveURLResult | undefined>,
): Promise<ResolveAttempt> {
	try {
		const result = await resolveURL();
		return result ? { status: "resolved", result } : { status: "missing" };
	} catch (error) {
		return { status: "failed", error };
	}
}

/**
 * 失败写回规则：当前值仍属于本函数可替换的范围时写入失败图。
 *
 * 可替换：值为空（含 CSS 的 `none`，元素当前没有可视内容）、仍是本函数写入的
 * 等待值、或仍是解析开始前读到的原始值。
 * 不可替换：外部写入了另一个有效值（典型场景是虚拟列表复用 DOM 节点），
 * 此时保留外部内容。
 */
export function shouldWriteFailure(
	current: string | null,
	waitingValue: string,
	originalValue: string,
): boolean {
	if (!current || current === "none") return true;
	return current === waitingValue || current === originalValue;
}

/** 失败时展示的图：自定义错误按错误类型自带的文案取图，其余回退通用失败图 */
export function failureImageFor(
	attempt: UnresolvedAttempt,
	failures: FailureImageSource,
): string {
	return attempt.status === "failed"
		? failures.forError(attempt.error)
		: failures.notFound;
}

/**
 * 非 ResolveURLError 的解析异常是代码缺陷，而非可预期的网络/内容失败。
 * 展示层已写入通用失败图，这里继续向上抛出，由调用方合并成一条提示。
 */
export function rethrowUnexpectedFailure(attempt: UnresolvedAttempt): void {
	if (
		attempt.status === "failed" &&
		!(attempt.error instanceof ResolveURLError)
	) {
		throw attempt.error;
	}
}

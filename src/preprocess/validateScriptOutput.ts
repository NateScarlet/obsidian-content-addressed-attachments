import type { PreProcessOutput } from "./shared-types";

/**
 * 校验预处理脚本的返回值，非法时抛出带脚本 URL 上下文的错误。
 *
 * 脚本为第三方动态加载代码，类型声明在运行期不生效，必须在此处做运行期校验。
 */
export function assertScriptOutput(
	result: unknown,
	scriptURL: string,
): asserts result is PreProcessOutput {
	const location = `[preprocess] Invalid script output from ${scriptURL}:`;
	if (
		typeof result !== "object" ||
		result === null ||
		Array.isArray(result)
	) {
		throw new Error(`${location} expected an object, got ${typeof result}`);
	}

	const { data, mimeType, filename } = result as Record<string, unknown>;
	if (!(data instanceof ArrayBuffer)) {
		throw new Error(`${location} 'data' must be an ArrayBuffer`);
	}
	// mimeType/filename 类型定义中为必填且不能为空，脚本可以直接使用 input 值，
	// 返回空值说明脚本内部实现有问题
	if (typeof mimeType !== "string" || mimeType === "") {
		throw new Error(`${location} 'mimeType' must be a non-empty string`);
	}
	if (typeof filename !== "string" || filename === "") {
		throw new Error(`${location} 'filename' must be a non-empty string`);
	}
}

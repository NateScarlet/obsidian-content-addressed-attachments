import mimeTypeByExtension from "./mimeTypeByExtension";

/**
 * 解析 MIME 类型：若显式提供了 format 则使用它，否则尝试从文件名后缀推断。
 * 无法推断时返回 `"application/octet-stream"`。
 */
export function resolveMimeType(
	format: string | undefined,
	filename: string,
): string {
	if (format) return format;
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex === -1) return "application/octet-stream";
	return mimeTypeByExtension(filename.slice(dotIndex));
}
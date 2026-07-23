// #region 从文件名后缀推断 MIME 类型

const EXT_MIME_MAP: Record<string, string> = {
	// 图片
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".tiff": "image/tiff",
	".tif": "image/tiff",

	// 文档
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx":
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".md": "text/markdown",
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".ts": "text/typescript",

	// 音视频
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",

	// 压缩包
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
	".7z": "application/x-7z-compressed",
	".rar": "application/vnd.rar",
};

// #endregion

/**
 * 从文件名后缀推断 MIME 类型。
 * 若无法从后缀推断，返回 `"application/octet-stream"`。
 */
export function inferMimeType(filename: string): string {
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex === -1) return "application/octet-stream";

	const ext = filename.slice(dotIndex).toLowerCase();
	return EXT_MIME_MAP[ext] ?? "application/octet-stream";
}

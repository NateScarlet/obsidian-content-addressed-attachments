/** 根据带点的后缀名，返回常见浏览器支持格式的 mime 类型，未知时返回 application/octet-stream */
export default function mimeTypeByExtension(ext: string): string {
	switch (ext.toLowerCase()) {
		// 图片格式
		case ".jpg":
		case ".jpeg":
		case ".jpe":
		case ".jfif":
		case ".pjpeg":
		case ".pjp":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".apng":
			return "image/apng";
		case ".avif":
			return "image/avif";
		case ".heic":
			return "image/heic";
		case ".heif":
			return "image/heif";
		case ".gif":
			return "image/gif";
		case ".bmp":
			return "image/bmp";
		case ".ico":
		case ".cur":
			return "image/x-icon";
		case ".svg":
			return "image/svg+xml";
		case ".tif":
		case ".tiff":
			return "image/tiff";

		// 视频格式
		case ".mp4":
			return "video/mp4";
		case ".webm":
			return "video/webm";
		case ".mov":
			return "video/quicktime";
		case ".avi":
			return "video/x-msvideo";
		case ".mpeg":
		case ".mpg":
		case ".mpe":
			return "video/mpeg";
		case ".3gp":
			return "video/3gpp";
		case ".3g2":
			return "video/3gpp2";
		case ".ogv":
			return "video/ogg";
		case ".flv":
			return "video/x-flv";

		// 音频格式
		case ".mp3":
			return "audio/mpeg";
		case ".wav":
			return "audio/wav";
		case ".ogg":
		case ".oga":
		case ".opus":
			return "audio/ogg";
		case ".flac":
			return "audio/flac";
		case ".m4a":
			return "audio/mp4";
		case ".aac":
			return "audio/aac";
		case ".weba":
			return "audio/webm";
		case ".mid":
		case ".midi":
			return "audio/midi";

		// 文本格式
		case ".txt":
		case ".log":
			return "text/plain";
		case ".html":
		case ".htm":
			return "text/html";
		case ".css":
			return "text/css";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "application/javascript";
		case ".json":
			return "application/json";
		case ".xml":
			return "application/xml";
		case ".csv":
			return "text/csv";
		case ".md":
		case ".markdown":
			return "text/markdown";

		// 文档格式
		case ".pdf":
			return "application/pdf";
		case ".doc":
			return "application/msword";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".xls":
			return "application/vnd.ms-excel";
		case ".xlsx":
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case ".ppt":
			return "application/vnd.ms-powerpoint";
		case ".pptx":
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case ".odt":
			return "application/vnd.oasis.opendocument.text";
		case ".ods":
			return "application/vnd.oasis.opendocument.spreadsheet";
		case ".odp":
			return "application/vnd.oasis.opendocument.presentation";

		// 字体格式
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		case ".ttf":
			return "font/ttf";
		case ".otf":
			return "font/otf";
		case ".eot":
			return "application/vnd.ms-fontobject";

		// 压缩文件
		case ".zip":
			return "application/zip";
		case ".rar":
			return "application/x-rar-compressed";
		case ".7z":
			return "application/x-7z-compressed";
		case ".tar":
			return "application/x-tar";
		case ".gz":
		case ".gzip":
			return "application/gzip";

		// 其他常见格式
		case ".wasm":
			return "application/wasm";
		case ".webmanifest":
			return "application/manifest+json";
		case ".rtf":
			return "application/rtf";
		case ".sh":
			return "application/x-sh";
		case ".exe":
			return "application/x-msdownload";
		case ".dmg":
			return "application/x-apple-diskimage";
		case ".ics":
			return "text/calendar";
		case ".php":
			return "application/x-httpd-php";

		default:
			return "application/octet-stream";
	}
}

/**
 * 返回最终生效的 MIME 类型：当前值缺失或为通用占位类型时按文件名后缀推断，
 * 否则原样返回当前值。无法识别后缀时原样返回当前值。
 */
export function effectiveMimeType(mimeType: string, filename: string): string {
	if (mimeType && mimeType !== "application/octet-stream") {
		return mimeType;
	}
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex === -1) {
		return mimeType;
	}
	const inferred = mimeTypeByExtension(filename.slice(dotIndex));
	return inferred === "application/octet-stream" ? mimeType : inferred;
}

/**
 * ImageMagick WASM 转换 Worker。
 *
 * 由主脚本（imagemagick.ts）通过 Blob URL 创建为 module worker，
 * 在独立线程中执行同步的 ImageMagick 转换，避免阻塞 Obsidian 界面线程。
 *
 * 消息协议：
 *   in:  { type: "convert", id, input: PreProcessInput, format, quality, wasmURL }
 *   out: { type: "result", id, output: PreProcessOutput | undefined, error?: string }
 */

import {
	initializeImageMagick,
	ConfigurationFiles,
	ImageMagick,
	MagickFormat,
	type IMagickImage,
} from "@imagemagick/magick-wasm";

// 本文件运行于 Web Worker 环境，self 使用 DOM lib 的 Worker 接口
// （其 postMessage 支持 transfer list 重载）。
declare const self: Worker;

/** convert 请求 */
interface ConvertRequest {
	type: "convert";
	id: number;
	input: {
		data: ArrayBuffer;
		mimeType: string;
		filename: string;
	};
	format: string;
	quality: number;
	/** magick.wasm 的绝对 URL（由主脚本解析，worker 内 import.meta.url 是 blob 无相对路径） */
	wasmURL: string;
}

/** convert 响应 */
interface ConvertResponse {
	type: "result";
	id: number;
	output?: {
		data: ArrayBuffer;
		mimeType: string;
		filename: string;
	};
	error?: string;
}

let initialized = false;
let initPromise: Promise<void> | null = null;

/** 初始化 ImageMagick WASM（按 wasmURL 惰性加载一次） */
function ensureInitialized(wasmURL: string): Promise<void> {
	if (initialized) return Promise.resolve();
	if (initPromise) return initPromise;

	initPromise = (async () => {
		// wasm 通过 app:// 资源协议加载，requestUrl 只支持 HTTP/HTTPS，必须使用 fetch
		// eslint-disable-next-line no-restricted-globals
		const response = await fetch(wasmURL);
		const wasmBytes = new Uint8Array(await response.arrayBuffer());
		await initializeImageMagick(wasmBytes, ConfigurationFiles.default);
		initialized = true;
	})();

	return initPromise;
}

/** format 参数 → MagickFormat 常量名与 MIME 类型映射 */
const FORMAT_CONFIG: Record<string, { magick: string; mime: string }> = {
	avif: { magick: "Avif", mime: "image/avif" },
	webp: { magick: "WebP", mime: "image/webp" },
	jpeg: { magick: "Jpeg", mime: "image/jpeg" },
	jpg: { magick: "Jpeg", mime: "image/jpeg" },
	png: { magick: "Png", mime: "image/png" },
};

/**
 * 执行一次图片转换。
 * 返回转换后的文件。抛错表示转换失败，由调用方决定如何处理。
 */
function convertImage(
	input: ConvertRequest["input"],
	format: string,
	quality: number,
): { data: Uint8Array; mime: string } {
	const config = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.avif;
	const targetMime = config.mime;

	const targetFormat =
		MagickFormat[config.magick as keyof typeof MagickFormat];
	if (targetFormat === undefined) {
		throw new Error(
			`Unknown MagickFormat: ${config.magick} for format: ${format}`,
		);
	}

	const resultData = ImageMagick.read<Uint8Array | null>(
		new Uint8Array(input.data),
		(image: IMagickImage) => {
			image.quality = quality;
			image.autoOrient();
			image.strip();

			let written: Uint8Array | null = null;
			image.write(targetFormat, (data: Uint8Array) => {
				// write 回调的 data 指向 native 内存，函数返回后会被立刻释放，
				// 必须先拷贝成普通 Uint8Array 再带出回调（见 magick-wasm 文档 #185）
				written = new Uint8Array(data);
			});
			return written;
		},
	);

	if (!resultData) {
		throw new Error("ImageMagick.read returned null");
	}

	return { data: resultData, mime: targetMime };
}

// #region Worker 消息处理
self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
	const request = event.data;
	if (!request || request.type !== "convert") return;

	let output: ConvertResponse["output"];
	try {
		await ensureInitialized(request.wasmURL);

		const config = FORMAT_CONFIG[request.format] ?? FORMAT_CONFIG.avif;

		// 已经是目标格式，跳过（返回 undefined 保留原始文件）
		if (request.input.mimeType === config.mime) {
			output = undefined;
		} else {
			// 生成新文件名
			const baseName =
				request.input.filename.replace(/\.[^.]+$/, "") || "image";
			const ext = request.format === "jpeg" ? "jpg" : request.format;

			const { data, mime } = convertImage(
				request.input,
				request.format,
				request.quality,
			);

			output = {
				data: (data.buffer as ArrayBuffer).slice(
					data.byteOffset,
					data.byteOffset + data.byteLength,
				),
				mimeType: mime,
				filename: `${baseName}.${ext}`,
			};
		}
	} catch (err) {
		const message = (err as Error).message;
		self.postMessage({
			type: "result",
			id: request.id,
			error: message,
		} satisfies ConvertResponse);
		return;
	}

	self.postMessage(
		{
			type: "result",
			id: request.id,
			output,
		} satisfies ConvertResponse,
		output ? [output.data] : [],
	);
};
// #endregion

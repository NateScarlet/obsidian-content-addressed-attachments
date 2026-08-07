/**
 * ImageMagick WASM 图片转换脚本。
 *
 * 使用 @imagemagick/magick-wasm 进行图片格式转换。
 * 支持所有 ImageMagick 可读的输入格式，输出格式由 params 指定。
 *
 * 参数：
 *   - format: 输出格式（avif | webp | jpeg | png），默认 avif
 *   - quality: 编码质量（1-100），默认 60
 *
 * 构建后的脚本与 magick.wasm 位于同一目录，通过相对 import.meta.url 解析。
 */

import type { PreProcessInput, PreProcessContext, PreProcessOutput, PreProcessScriptModule } from "../src/preprocess/shared-types";

let initialized = false;
let initPromise: Promise<void> | null = null;

/** 初始化 ImageMagick WASM */
async function ensureInitialized(): Promise<void> {
	if (initialized) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		const { initializeImageMagick, ConfigurationFiles } =
			await import("@imagemagick/magick-wasm");
		const wasmURL = new URL("magick.wasm", import.meta.url);
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
 * 默认导出：使用 ImageMagick WASM 转换图片格式。
 *
 * - auto-orient：自动校正朝向
 * - strip：移除元数据
 * - quality：编码质量（默认 60）
 * - 如果转换后相比原始文件节省不足 10%，保留原始文件
 */
const transform = async function (
	input: PreProcessInput,
	ctx: PreProcessContext,
): Promise<PreProcessOutput | undefined> {
	// 只处理图片
	if (!input.mimeType.startsWith("image/")) {
		return undefined;
	}

	const format = ctx.params.get("format") || "avif";
	const quality = parseInt(ctx.params.get("quality") || "60", 10);
	const config = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.avif;
	const targetMime = config.mime;

	// 已经是目标格式，跳过
	if (input.mimeType === targetMime) {
		return undefined;
	}

	await ensureInitialized();

	const { ImageMagick, MagickFormat } =
		await import("@imagemagick/magick-wasm");
	const targetFormat =
		MagickFormat[config.magick as keyof typeof MagickFormat];

	try {
		const resultData = await ImageMagick.read<Uint8Array | null>(
			new Uint8Array(input.data),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async (image: any) => {
				image.quality = quality;
				image.autoOrient();
				image.strip();

				let written: Uint8Array | null = null;
				await image.write(targetFormat, (data: Uint8Array) => {
					// write 回调的 data 指向 native 内存，函数返回后会被立刻释放，
					// 必须先拷贝成普通 Uint8Array 再带出回调（见 magick-wasm 文档 #185）
					written = new Uint8Array(data);
				});
				return written;
			},
		);

		if (!resultData) {
			return undefined;
		}

		// 转换后比原始文件节省不足 10% 时保留原始文件
		if (resultData.byteLength > 0.9 * input.data.byteLength) {
			ctx.log(
				`${format.toUpperCase()} output saves less than 10%, keeping original: ${input.filename}`,
			);
			return undefined;
		}

		// 生成新文件名
		const baseName = input.filename.replace(/\.[^.]+$/, "") || "image";
		const ext = format === "jpeg" ? "jpg" : format;

		return {
			data: resultData.buffer as ArrayBuffer,
			mimeType: targetMime,
			filename: `${baseName}.${ext}`,
		};
	} catch (err) {
		ctx.log(
			`ImageMagick ${format.toUpperCase()} conversion failed for ${input.filename}: ${(err as Error).message}`,
		);
		return undefined;
	}
} satisfies PreProcessScriptModule["default"];

export default transform;

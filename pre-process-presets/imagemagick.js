/**
 * ImageMagick WASM 图片转换预设脚本。
 *
 * 使用 @imagemagick/magick-wasm 进行图片格式转换。
 * 支持所有 ImageMagick 可读的输入格式，输出格式由 params 指定。
 *
 * 参数：
 *   - format: 输出格式（avif | webp | jpeg | png），默认 avif
 *   - quality: 编码质量（1-100），默认 80
 *
 * 构建后的脚本通过 GitHub Release 分发，WASM 文件位于同一目录。
 */

// @ts-nocheck

let initialized = false;
let initPromise = null;

/** 返回脚本所在目录 URL */
function getScriptDir() {
	const url = new URL(import.meta.url);
	return url.href.slice(0, url.href.lastIndexOf("/") + 1);
}

/** 初始化 ImageMagick WASM */
async function ensureInitialized() {
	if (initialized) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		const { initializeImageMagick, Magick } = await import(
			"@imagemagick/magick-wasm"
		);
		const wasmURL = new URL("magick.wasm", getScriptDir()).href;
		const response = await fetch(wasmURL);
		const wasmBytes = new Uint8Array(await response.arrayBuffer());
		await initializeImageMagick(wasmBytes, Magick);
		initialized = true;
	})();

	return initPromise;
}

/** 获取 format 参数对应的 MagickFormat 常量名 */
function formatParamToMagickFormat(format) {
	const map = {
		avif: "Avif",
		webp: "WebP",
		jpeg: "Jpeg",
		jpg: "Jpeg",
		png: "Png",
	};
	return map[format] || "Avif";
}

/** 获取 format 参数对应的 MIME 类型 */
function formatParamToMimeType(format) {
	const map = {
		avif: "image/avif",
		webp: "image/webp",
		jpeg: "image/jpeg",
		jpg: "image/jpeg",
		png: "image/png",
	};
	return map[format] || "image/avif";
}

/**
 * 默认导出：使用 ImageMagick WASM 转换图片格式。
 */
export default async function transform(input, ctx) {
	// 只处理图片
	if (!input.mimeType.startsWith("image/")) {
		return undefined;
	}

	const format = ctx.params.get("format") || "avif";
	const quality = parseInt(ctx.params.get("quality") || "80", 10);
	const targetMime = formatParamToMimeType(format);

	// 已经是目标格式，跳过
	if (input.mimeType === targetMime) {
		return undefined;
	}

	await ensureInitialized();

	const { ImageMagick, MagickFormat } = await import(
		"@imagemagick/magick-wasm"
	);
	const targetFormat = MagickFormat[formatParamToMagickFormat(format)];

	try {
		let resultData = null;

		await ImageMagick.read(
			new Uint8Array(input.data),
			async (image) => {
				image.quality = quality;
				image.autoOrient();
				image.strip();

				await image.write(targetFormat, (data) => {
					resultData = data;
				});
			},
		);

		if (!resultData) {
			return undefined;
		}

		// 如果转换后反而更大，保留原始文件
		if (resultData.byteLength >= input.data.byteLength) {
			ctx.log(
				`${format.toUpperCase()} output is larger than input, keeping original: ${input.filename}`,
			);
			return undefined;
		}

		// 生成新文件名
		const baseName =
			input.filename.replace(/\.[^.]+$/, "") || "image";
		const ext = format === "jpeg" ? "jpg" : format;

		return {
			data: resultData.buffer,
			mimeType: targetMime,
			filename: `${baseName}.${ext}`,
		};
	} catch (err) {
		ctx.log(
			`ImageMagick ${format.toUpperCase()} conversion failed for ${input.filename}: ${err.message}`,
		);
		return undefined;
	}
}
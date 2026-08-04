/**
 * WebP 图片转换预设脚本。
 *
 * 将图片转换为 WebP 格式，使用浏览器原生编码能力。
 * 参数：
 *   - quality: 编码质量 (0-1)，默认 0.8
 *
 * 此脚本通过 plugin 的预处理管线动态 import() 加载。
 * 发布后通过 IPFS 分发，CID 记录在预设索引中。
 */

/**
 * WebP 转换默认导出
 */
export default async function transformWebP(input, ctx) {
	// 只处理图片
	if (!input.mimeType.startsWith("image/")) {
		return undefined;
	}

	// 已经是 WebP 格式，跳过
	if (input.mimeType === "image/webp") {
		return undefined;
	}

	// 从参数读取质量设置
	const quality = parseFloat(ctx.params.quality || "0.8");

	// 尝试解码并编码为 WebP
	try {
		const blob = new Blob([input.data], { type: input.mimeType });
		const bitmap = await createImageBitmap(blob);

		// 使用 Canvas 编码为 WebP
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx2d = canvas.getContext("2d");
		ctx2d.drawImage(bitmap, 0, 0);
		bitmap.close();

		const webpBlob = await canvas.convertToBlob({
			type: "image/webp",
			quality,
		});

		const webpBuffer = await webpBlob.arrayBuffer();

		// 如果 WebP 编码后反而更大，保留原始文件
		if (webpBuffer.byteLength >= input.data.byteLength) {
			ctx.log(
				"WebP output is larger than input, keeping original:",
				input.filename,
			);
			return undefined;
		}

		// 生成新文件名
		const baseName = input.filename.replace(/\.[^.]+$/, "") || "image";

		return {
			data: webpBuffer,
			mimeType: "image/webp",
			filename: `${baseName}.webp`,
		};
	} catch (err) {
		ctx.log("WebP encoding failed:", err);
		return undefined;
	}
}
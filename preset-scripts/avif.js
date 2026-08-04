/**
 * AVIF 图片转换预设脚本。
 *
 * 将图片转换为 AVIF 格式，使用 @jsquash/avif 进行编码。
 * 参数：
 *   - quality: 编码质量 (1-100)，默认 80
 *
 * 此脚本通过 plugin 的预处理管线动态 import() 加载。
 * 发布后通过 IPFS 分发，CID 记录在预设索引中。
 */

// @ts-ignore - @jsquash/avif 在运行时通过 import() 加载
let avifEncoder = null;

async function getEncoder() {
	if (!avifEncoder) {
		try {
			const mod = await import(
				/* @vite-ignore */ "@jsquash/avif"
			);
			avifEncoder = mod;
		} catch {
			// 降级处理：wasm 未找到时抛出异常让管线保留原始文件
			throw new Error("AVIF encoder not available");
		}
	}
	return avifEncoder;
}

/**
 * AVIF 转换默认导出
 */
export default async function transformAVIF(input, ctx) {
	// 只处理图片
	if (!input.mimeType.startsWith("image/")) {
		return undefined;
	}

	// 已经是 AVIF 格式，跳过
	if (input.mimeType === "image/avif") {
		return undefined;
	}

	// 从参数读取质量设置
	const quality = parseInt(ctx.params.quality || "80", 10);

	// 尝试解码输入图片
	let imageData;
	try {
		const blob = new Blob([input.data], { type: input.mimeType });
		const bitmap = await createImageBitmap(blob);

		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx2d = canvas.getContext("2d");
		ctx2d.drawImage(bitmap, 0, 0);

		imageData = ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
		bitmap.close();
	} catch {
		// 解码失败，保留原始文件
		ctx.log("Failed to decode image:", input.filename);
		return undefined;
	}

	// 使用 @jsquash/avif 编码
	const encoder = await getEncoder();
	try {
		const avifBuffer = await encoder.encode(imageData, { quality });

		// 如果 AVIF 编码后反而更大，保留原始文件
		if (avifBuffer.byteLength >= input.data.byteLength) {
			ctx.log(
				"AVIF output is larger than input, keeping original:",
				input.filename,
			);
			return undefined;
		}

		// 生成新文件名：将原扩展名替换为 .avif
		const baseName = input.filename.replace(/\.[^.]+$/, "") || "image";

		return {
			data: avifBuffer,
			mimeType: "image/avif",
			filename: `${baseName}.avif`,
		};
	} catch (err) {
		ctx.log("AVIF encoding failed:", err);
		return undefined;
	}
}
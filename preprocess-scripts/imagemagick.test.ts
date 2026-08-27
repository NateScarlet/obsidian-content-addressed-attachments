import { describe, expect, it, vi } from "vitest";
import { createTransform } from "./imagemagick";
import type {
	PreProcessContext,
	PreProcessInput,
	PreProcessOutput,
} from "../src/preprocess/shared-types";

// #region 测试工具

function makeInput(overrides: Partial<PreProcessInput> = {}): PreProcessInput {
	return {
		data: new ArrayBuffer(100),
		mimeType: "",
		filename: "photo.png",
		...overrides,
	};
}

function makeCtx(params: Record<string, string> = {}): PreProcessContext {
	return {
		log: vi.fn(),
		params: new URLSearchParams(params),
	};
}

function makeOutput(size: number): PreProcessOutput {
	return {
		data: new ArrayBuffer(size),
		mimeType: "image/webp",
		filename: "photo.webp",
	};
}

// #endregion

describe("imagemagick transform", () => {
	it("skips non-image files without invoking convert", async () => {
		const convert = vi.fn().mockResolvedValue(undefined);
		const transform = createTransform(convert);

		const result = await transform(
			makeInput({ mimeType: "text/plain", filename: "note.txt" }),
			makeCtx(),
		);

		expect(result).toBeUndefined();
		expect(convert).not.toHaveBeenCalled();
	});

	it.each([
		["photo.heic", "image/heic"],
		["photo.jpg", "image/jpeg"],
		["photo.svg", "image/svg+xml"],
		["photo.tif", "image/tiff"],
	])(
		"infers mime type %s -> %s from extension when missing",
		async (filename, expectedMime) => {
			const convert = vi.fn().mockResolvedValue(makeOutput(50));
			const transform = createTransform(convert);

			await transform(makeInput({ mimeType: "", filename }), makeCtx());

			expect(convert).toHaveBeenCalledWith(
				expect.objectContaining({ mimeType: expectedMime }),
				"avif",
				80,
				expect.any(String),
			);
		},
	);

	it("re-infers mime type when input is generic application/octet-stream", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(50));
		const transform = createTransform(convert);

		await transform(
			makeInput({
				mimeType: "application/octet-stream",
				filename: "photo.heic",
			}),
			makeCtx(),
		);

		expect(convert).toHaveBeenCalledWith(
			expect.objectContaining({ mimeType: "image/heic" }),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("keeps original when source is displayable and savings below minSavings", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(95));
		const transform = createTransform(convert);

		// 原始 100 字节、minSavings=10：转换结果需 ≤90 字节才被采用
		const result = await transform(
			makeInput({ mimeType: "image/png" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeUndefined();
	});

	it("accepts result when source is displayable and savings meet minSavings", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(90));
		const transform = createTransform(convert);

		// 恰好达到 10% 节省阈值（90 字节）时不丢弃
		const result = await transform(
			makeInput({ mimeType: "image/png" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeDefined();
	});

	it("always accepts conversion when source format is not displayable in Obsidian", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(150));
		const transform = createTransform(convert);

		// heic 无法被 Obsidian 直接显示：即使转换后体积更大也采用结果
		const result = await transform(
			makeInput({ mimeType: "image/heic", filename: "photo.heic" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeDefined();
	});

	it("always accepts conversion from tiff regardless of savings", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(120));
		const transform = createTransform(convert);

		const result = await transform(
			makeInput({ mimeType: "image/tiff", filename: "photo.tiff" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeDefined();
	});

	it("always accepts conversion from avif regardless of savings", async () => {
		const convert = vi.fn().mockResolvedValue(makeOutput(120));
		const transform = createTransform(convert);

		// avif 桌面端可显示但移动端不保证：不在白名单内，总是转换以保证兼容性
		const result = await transform(
			makeInput({ mimeType: "image/avif", filename: "photo.avif" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeDefined();
	});

	it("applies minSavings when target format equals source format", async () => {
		const convert = vi.fn().mockResolvedValue({
			data: new ArrayBuffer(150),
			mimeType: "image/avif",
			filename: "photo.avif",
		});
		const transform = createTransform(convert);

		// 目标格式与源格式相同没有兼容性收益，即使源格式不在白名单内
		// 也受 minSavings 约束。正常情况下 worker 会跳过同格式转换返回
		// undefined，此用例钉住 convert 未跳过时本层的兜底策略。
		const result = await transform(
			makeInput({ mimeType: "image/avif", filename: "photo.avif" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeUndefined();
	});

	it("accepts same-format conversion when savings meet minSavings", async () => {
		const convert = vi.fn().mockResolvedValue({
			data: new ArrayBuffer(80),
			mimeType: "image/avif",
			filename: "photo.avif",
		});
		const transform = createTransform(convert);

		// 同格式守卫只负责加门槛而不是一律拒绝：节省达标的结果仍被采用
		const result = await transform(
			makeInput({ mimeType: "image/avif", filename: "photo.avif" }),
			makeCtx({ minSavings: "10" }),
		);

		expect(result).toBeDefined();
	});

	it("returns undefined when convert reports no conversion needed", async () => {
		const convert = vi.fn().mockResolvedValue(undefined);
		const transform = createTransform(convert);

		const result = await transform(makeInput(), makeCtx());

		expect(result).toBeUndefined();
	});

	it("logs and keeps original when convert throws", async () => {
		const convert = vi.fn().mockRejectedValue(new Error("boom"));
		const transform = createTransform(convert);
		const ctx = makeCtx();

		const result = await transform(makeInput(), ctx);

		expect(result).toBeUndefined();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});
});

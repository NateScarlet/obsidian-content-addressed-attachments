import { describe, it, expect, vi } from "vitest";
import TransformPipeline from "./TransformPipeline";
import type { ScriptLoader, PreProcessScriptModule } from "./types";

describe("TransformPipeline", () => {
	function createMockScriptLoader(
		module: PreProcessScriptModule | undefined,
		params: Record<string, string> = {},
	): ScriptLoader {
		return {
			loadScript: vi.fn().mockResolvedValue(module),
			getParams: vi.fn().mockReturnValue(params),
			lockHTTPSURL: vi.fn(),
		};
	}

	it("returns undefined when scriptURL is empty", async () => {
		const loader = createMockScriptLoader(undefined);
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"",
		);

		expect(result).toBeUndefined();
		expect(loader.loadScript).not.toHaveBeenCalled();
	});

	it("returns undefined when script module has no default export", async () => {
		const loader = createMockScriptLoader({});
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result).toBeUndefined();
	});

	it("returns undefined when script loader fails", async () => {
		const loader = createMockScriptLoader(undefined);
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result).toBeUndefined();
	});

	it("returns result when script returns transformed data", async () => {
		const transformedData = new ArrayBuffer(4);
		const loader = createMockScriptLoader({
			default: async (input) => ({
				data: transformedData,
				mimeType: "image/avif",
				filename: "test.avif",
			}),
		});
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result).toEqual({
			data: transformedData,
			mimeType: "image/avif",
			filename: "test.avif",
		});
	});

	it("returns undefined when script returns undefined", async () => {
		const loader = createMockScriptLoader({
			default: async () => undefined,
		});
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result).toBeUndefined();
	});

	it("returns undefined when script throws", async () => {
		const loader = createMockScriptLoader({
			default: async () => {
				throw new Error("Script error");
			},
		});
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result).toBeUndefined();
	});

	it("falls back to input mimeType when result has no mimeType", async () => {
		const loader = createMockScriptLoader({
			default: async (input) => ({
				data: new ArrayBuffer(4),
				mimeType: "",
				filename: "test.avif",
			}),
		});
		const pipeline = new TransformPipeline(loader);

		const result = await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js",
		);

		expect(result?.mimeType).toBe("image/png");
	});

	it("passes params to script context", async () => {
		const defaultFn = vi.fn().mockResolvedValue(undefined);
		const loader = createMockScriptLoader(
			{ default: defaultFn },
			{ format: "avif", quality: "80" },
		);
		const pipeline = new TransformPipeline(loader);

		await pipeline.run(
			{
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			},
			"scripts/transform.js#format=avif&quality=80",
		);

		expect(defaultFn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				params: { format: "avif", quality: "80" },
			}),
		);
	});
});
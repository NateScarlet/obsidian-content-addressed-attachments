import { describe, it, expect, vi } from "vitest";
import TransformPipeline from "./TransformPipeline";
import type { ScriptLoader, PreProcessScriptModule } from "./types";

describe("TransformPipeline", () => {
	function createMockScriptLoader(
		module: PreProcessScriptModule | undefined,
		params: Record<string, string> = {},
	): ScriptLoader {
		const urlSearchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			urlSearchParams.set(key, value);
		}
		return {
			loadScript: vi.fn().mockResolvedValue(module),
			getParams: vi.fn().mockReturnValue(urlSearchParams),
		};
	}

	it("returns undefined when scriptURL is empty", async () => {
		const loader = createMockScriptLoader(undefined);
		const pipeline = new TransformPipeline(loader, () => "");

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toBeUndefined();
		// eslint-disable-next-line @typescript-eslint/unbound-method
		expect(loader.loadScript).not.toHaveBeenCalled();
	});

	it("returns undefined when script module has no default export", async () => {
		const loader = createMockScriptLoader({});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toBeUndefined();
	});

	it("returns undefined when script loader fails", async () => {
		const loader = createMockScriptLoader(undefined);
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toBeUndefined();
	});

	it("returns result when script returns transformed data", async () => {
		const transformedData = new ArrayBuffer(4);
		const loader = createMockScriptLoader({
			default: (input) => ({
				data: transformedData,
				mimeType: "image/avif",
				filename: "test.avif",
			}),
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toEqual({
			data: transformedData,
			mimeType: "image/avif",
			filename: "test.avif",
		});
	});

	it("returns undefined when script returns undefined", async () => {
		const loader = createMockScriptLoader({
			default: () => undefined,
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toBeUndefined();
	});

	it("returns undefined when script throws", async () => {
		const loader = createMockScriptLoader({
			default: () => {
				throw new Error("Script error");
			},
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result).toBeUndefined();
	});

	it("falls back to input mimeType when result has no mimeType", async () => {
		const loader = createMockScriptLoader({
			default: (input) => ({
				data: new ArrayBuffer(4),
				mimeType: "",
				filename: "test.avif",
			}),
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		const result = await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(result?.mimeType).toBe("image/png");
	});

	it("passes params to script context", async () => {
		const defaultFn = vi.fn().mockResolvedValue(undefined);
		const urlSearchParams = new URLSearchParams();
		urlSearchParams.set("format", "avif");
		urlSearchParams.set("quality", "80");
		const loader = {
			loadScript: vi.fn().mockResolvedValue({ default: defaultFn }),
			getParams: vi.fn().mockReturnValue(urlSearchParams),
		};
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js#format=avif&quality=80",
		);

		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		expect(defaultFn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				params: urlSearchParams,
			}),
		);
	});
});

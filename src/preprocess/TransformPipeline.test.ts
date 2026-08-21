import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TransformPipeline from "./TransformPipeline";
// 直接导入 mock 模块以获得带实例追踪的 Notice（vitest 将 "obsidian" 别名到同一文件）
import { Notice } from "../__mocks__/obsidian";
import type { ScriptLoader, PreProcessScriptModule } from "./types";

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
		clearCache: vi.fn(),
	};
}

describe("TransformPipeline", () => {
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

	it("throws when script module has no default export", async () => {
		const loader = createMockScriptLoader({});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("Script default export must be a function");
	});

	it("throws when script loader fails", async () => {
		const loader = createMockScriptLoader(undefined);
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("Failed to load script");
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

	it("rethrows error when script throws", async () => {
		const loader = createMockScriptLoader({
			default: () => {
				throw new Error("Script error");
			},
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("Script error");
	});

	it("throws when script output is missing data", async () => {
		const loader = createMockScriptLoader({
			default: () =>
				({
					mimeType: "image/avif",
					filename: "test.avif",
				}) as never,
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("'data' must be an ArrayBuffer");
	});

	it("throws when script output data is not an ArrayBuffer", async () => {
		const loader = createMockScriptLoader({
			default: () =>
				({
					data: "not an array buffer",
					mimeType: "image/avif",
				}) as never,
		});
		const pipeline = new TransformPipeline(
			loader,
			() => "scripts/transform.js",
		);

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("'data' must be an ArrayBuffer");
	});

	it("throws when result mimeType is empty instead of falling back", async () => {
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

		await expect(
			pipeline.run({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				filename: "test.png",
			}),
		).rejects.toThrow("'mimeType' must be a non-empty string");
	});

	it("passes params to script context", async () => {
		const defaultFn = vi.fn().mockResolvedValue(undefined);
		const urlSearchParams = new URLSearchParams();
		urlSearchParams.set("format", "avif");
		urlSearchParams.set("quality", "80");
		const loader = {
			loadScript: vi.fn().mockResolvedValue({ default: defaultFn }),
			getParams: vi.fn().mockReturnValue(urlSearchParams),
			clearCache: vi.fn(),
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

describe("TransformPipeline log batching (§3)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Notice.instances.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createLoggingScriptLoader(messages: string[]): {
		loader: ScriptLoader;
		pipeline: TransformPipeline;
	} {
		const loader = createMockScriptLoader({
			default: (_input, ctx) => {
				for (const message of messages) {
					ctx.log(message);
				}
				return undefined;
			},
		});
		return {
			loader,
			pipeline: new TransformPipeline(
				loader,
				() => "scripts/transform.js",
			),
		};
	}

	/** 每次运行依次记录 batches 中的一组日志 */
	function createBatchedLoggingScriptLoader(
		batches: string[][],
	): TransformPipeline {
		const loader = createMockScriptLoader({
			default: (_input, ctx) => {
				for (const message of batches.shift() ?? []) {
					ctx.log(message);
				}
				return undefined;
			},
		});
		return new TransformPipeline(loader, () => "scripts/transform.js");
	}

	it("merges logs within the batch window into a single Notice", async () => {
		const { pipeline } = createLoggingScriptLoader(["first", "second"]);

		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		// 窗口未到期时不弹出
		expect(Notice.instances.length).toBe(0);
		vi.advanceTimersByTime(500);

		expect(Notice.instances.length).toBe(1);
		expect(Notice.instances[0].message).toBe("[preprocess]\nfirst\nsecond");
	});

	it("emits separate Notices for logs in different windows on the same pipeline", async () => {
		const pipeline = createBatchedLoggingScriptLoader([
			["early"],
			["late"],
		]);

		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});
		vi.advanceTimersByTime(500);
		expect(Notice.instances.length).toBe(1);

		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});
		vi.advanceTimersByTime(500);

		expect(Notice.instances.length).toBe(2);
		expect(Notice.instances[1].message).toBe("[preprocess]\nlate");
	});

	it("drops logs arriving after dispose without scheduling timers", async () => {
		const pipeline = createBatchedLoggingScriptLoader([["in-flight"]]);

		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});
		pipeline.dispose();
		expect(Notice.instances.length).toBe(1);
		expect(Notice.instances[0].message).toContain("in-flight");

		// 模拟卸载后仍在途的 run 调用产生日志：应被丢弃且不再调度定时器
		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});
		vi.advanceTimersByTime(1000);
		expect(Notice.instances.length).toBe(1);
	});

	it("flushes pending logs on dispose and cancels the pending timer", async () => {
		const { pipeline } = createLoggingScriptLoader(["pending"]);
		await pipeline.run({
			data: new ArrayBuffer(8),
			mimeType: "image/png",
			filename: "test.png",
		});

		pipeline.dispose();
		expect(Notice.instances.length).toBe(1);
		expect(Notice.instances[0].message).toContain("pending");

		// 定时器已清理：推进时间不再产生额外通知（§5 资源 100% 回收）
		vi.advanceTimersByTime(1000);
		expect(Notice.instances.length).toBe(1);
	});

	it("dispose without pending logs shows nothing", () => {
		new TransformPipeline(
			createMockScriptLoader(undefined),
			() => "",
		).dispose();
		expect(Notice.instances.length).toBe(0);
	});
});

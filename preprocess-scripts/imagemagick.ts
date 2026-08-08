/**
 * ImageMagick WASM 图片转换脚本（主线程侧）。
 *
 * 将转换任务交给 Web Worker（imagemagick.worker.js）执行，
 * 避免 @imagemagick/magick-wasm 的同步 API 阻塞 Obsidian 界面线程。
 * 支持所有 ImageMagick 可读的输入格式，输出格式由 params 指定。
 *
 * 参数：
 *   - format: 输出格式（avif | webp | jpeg | png），默认 avif
 *   - quality: 编码质量（1-100），默认 80
 *   - minSavings: 最小节省百分比（0-100），默认 10。
 *     当转换后体积相比原始文件节省低于该百分比时保留原始文件。
 *
 * 构建后的脚本、worker 脚本与 magick.wasm 位于同一目录，
 * 通过相对 import.meta.url 解析。worker 由 Blob URL 创建（app:// 不支持
 * 直接 new Worker），wasm 绝对 URL 通过消息传递给 worker。
 */

import type {
	PreProcessInput,
	PreProcessOutput,
	PreProcessContext,
	PreProcessScriptModule,
} from "../src/preprocess/shared-types";

// #region Worker 通信
/** convert 请求（与 worker 共享的消息形状） */
interface ConvertRequest {
	type: "convert";
	id: number;
	input: PreProcessInput;
	format: string;
	quality: number;
	wasmURL: string;
}

/** convert 响应 */
interface ConvertResponse {
	type: "result";
	id: number;
	output?: PreProcessOutput;
	error?: string;
}

let workerPromise: Promise<Worker> | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<
	number,
	{
		resolve: (output: PreProcessOutput | undefined) => void;
		reject: (err: Error) => void;
	}
>();

/** 获取 worker 单例（懒创建，由 Blob URL 加载 module worker） */
async function getWorker(): Promise<Worker> {
	if (workerPromise) return workerPromise;

	workerPromise = (async () => {
		try {
			const workerURL = new URL("imagemagick.worker.js", import.meta.url);
			// worker 源码通过 fetch 读取文本后以 Blob URL 创建：
			// Obsidian 的资源协议 app:// 不支持直接 `new Worker(app://...)`，
			// 但 fetch app:// 可用（见 .scratch 实测）。
			// wasm 通过 app:// 资源协议加载，requestUrl 只支持 HTTP/HTTPS，必须使用 fetch
			// eslint-disable-next-line no-restricted-globals
			const code = await (await fetch(workerURL)).text();
			const blobURL = URL.createObjectURL(
				new Blob([code], { type: "text/javascript" }),
			);
			const instance = new Worker(blobURL, { type: "module" });

			instance.onmessage = (event: MessageEvent<ConvertResponse>) => {
				const response = event.data;
				const pending = pendingRequests.get(response.id);
				if (!pending) return;
				pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(response.error));
				} else {
					pending.resolve(response.output);
				}
			};
			instance.onerror = (event) => {
				for (const pending of pendingRequests.values()) {
					pending.reject(new Error(`Worker error: ${event.message}`));
				}
				pendingRequests.clear();
				workerPromise = null;
			};

			return instance;
		} catch (err) {
			// 创建失败（worker 源码 fetch 404 等），重置以便下次重试
			workerPromise = null;
			throw err instanceof Error ? err : new Error(String(err));
		}
	})();

	return workerPromise;
}

/** 发送一次转换请求，返回 Promise<输出或 undefined> */
function requestConvert(
	input: PreProcessInput,
	format: string,
	quality: number,
	wasmURL: string,
): Promise<PreProcessOutput | undefined> {
	const id = nextRequestId++;
	return new Promise<PreProcessOutput | undefined>((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject });
		void getWorker().then(
			(instance) => {
				instance.postMessage({
					type: "convert",
					id,
					input,
					format,
					quality,
					wasmURL,
				} satisfies ConvertRequest);
			},
			(err) => {
				// worker 创建失败时清理挂起请求
				pendingRequests.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
// #endregion

/**
 * 默认导出：使用 ImageMagick WASM（在 Web Worker 中）转换图片格式。
 *
 * - auto-orient：自动校正朝向
 * - strip：移除元数据
 * - quality：编码质量（默认 80）
 * - minSavings：转换后节省低于该百分比时保留原始文件（默认 10）
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
	const quality = parseInt(ctx.params.get("quality") || "80", 10);
	const minSavings = parseInt(ctx.params.get("minSavings") || "10", 10);
	const wasmURL = new URL("magick.wasm", import.meta.url).href;

	const originalSize = input.data.byteLength;

	let result: PreProcessOutput | undefined;
	try {
		result = await requestConvert(input, format, quality, wasmURL);
	} catch (err) {
		ctx.log(
			`ImageMagick ${format.toUpperCase()} conversion failed for ${input.filename}: ${(err as Error).message}`,
		);
		return undefined;
	}

	// worker 返回 undefined 表示已目标格式，跳过
	if (!result) {
		return undefined;
	}

	// 转换后节省低于 minSavings% 时保留原始文件
	// （与 pre-commit.py 一致：无论同格式/跨格式转码都应用该阈值）
	if (result.data.byteLength > ((100 - minSavings) / 100) * originalSize) {
		ctx.log(
			`${format.toUpperCase()} output saves less than ${minSavings}%, keeping original: ${input.filename}`,
		);
		return undefined;
	}

	return result;
} satisfies PreProcessScriptModule["default"];

export default transform;

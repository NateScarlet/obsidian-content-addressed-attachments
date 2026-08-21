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
 *     仅当原格式是 Obsidian 各端都能直接显示的图片格式时，
 *     转换后体积相比原始文件节省低于该百分比才保留原始文件；
 *     原格式存在无法直接显示的平台（如 heic/tiff/avif）时总是采用转换结果，
 *     因为转换为广泛兼容的格式本身就是收益。
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
import { effectiveMimeType } from "../src/utils/mimeTypeByExtension";

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
 * Obsidian 各端（Electron / iOS WKWebView / Android WebView）都能直接显示的
 * 图片 MIME 类型。仅这些格式作为原格式时受 minSavings 阈值约束。
 *
 * avif 虽然桌面端 Chromium 可解码，但移动端取决于系统 WebView/OS 版本，
 * 不在保证集合内；heic/heif/tiff 桌面端完全无法显示。
 * 集合宁缺毋滥：误排除只会导致总是转换（输出兼容性更好），
 * 误包含会在部分平台保留无法显示的原始文件。
 */
const OBSIDIAN_DISPLAYABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
	"image/png",
	"image/apng",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
	"image/x-icon",
]);

/** 转换依赖：执行一次格式转换，返回 undefined 表示已是目标格式无需转换 */
export type ConvertFn = (
	input: PreProcessInput,
	format: string,
	quality: number,
	wasmURL: string,
) => Promise<PreProcessOutput | undefined>;

/**
 * 创建图片转换脚本入口，convert 依赖显式注入以便测试替换。
 *
 * - auto-orient：自动校正朝向
 * - strip：移除元数据
 * - quality：编码质量（默认 80）
 * - minSavings：仅当原格式是 Obsidian 各端都能直接显示的图片时，
 *   转换后节省低于该百分比才保留原始文件（默认 10）
 */
export function createTransform(convert: ConvertFn) {
	return async function (
		input: PreProcessInput,
		ctx: PreProcessContext,
	): Promise<PreProcessOutput | undefined> {
		// 上游未提供可信 mime 时按扩展名推断（复用项目共享映射）
		const mimeType = effectiveMimeType(input.mimeType, input.filename);

		// 只处理图片
		if (!mimeType.startsWith("image/")) {
			return undefined;
		}

		const normalizedInput =
			mimeType !== input.mimeType ? { ...input, mimeType } : input;

		const format = ctx.params.get("format") || "avif";
		const quality = parseInt(ctx.params.get("quality") || "80", 10);
		const minSavings = parseInt(ctx.params.get("minSavings") || "10", 10);
		const wasmURL = new URL("magick.wasm", import.meta.url).href;

		const originalSize = input.data.byteLength;

		let result: PreProcessOutput | undefined;
		try {
			result = await convert(normalizedInput, format, quality, wasmURL);
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

		// 原格式各端都可直接显示时，转换收益仅为体积：
		// 节省低于 minSavings% 则保留原始文件。
		// 原格式存在无法直接显示的平台时，转为广泛兼容格式本身就是收益，
		// 不受该阈值约束（否则会因最低节省要求而留下无法显示的原始文件）。
		if (
			OBSIDIAN_DISPLAYABLE_IMAGE_MIMES.has(mimeType) &&
			result.data.byteLength > ((100 - minSavings) / 100) * originalSize
		) {
			ctx.log(
				`${format.toUpperCase()} output saves less than ${minSavings}%, keeping original: ${input.filename}`,
			);
			return undefined;
		}

		return result;
	} satisfies PreProcessScriptModule["default"];
}

const transform = createTransform(requestConvert);

export default transform;

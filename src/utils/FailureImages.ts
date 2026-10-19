import createImagePlaceholderSVG from "./createImagePlaceholderSVG";
import localizedText from "./localizedText";
import defineLocales from "./defineLocales";
import ResolveURLError from "../ResolveURLError";

const { t } = defineLocales({
	en: {
		genericFailure: "Failed to load",
	},
	zh: {
		genericFailure: "加载失败",
	},
});

/**
 * 元素补丁可用的失败图来源。
 *
 * 补丁函数只依赖这两个入口，测试可注入替身而不需要真实的 blob URL。
 */
export interface FailureImageSource {
	/** 合法缺失（解析无结果）时展示的图 */
	readonly notFound: string;
	/** 解析抛错时按错误对象选择失败图 */
	forError(error: unknown): string;
}

/**
 * 元素级失败占位图的资源管理。
 *
 * 文案来源：`ResolveURLError` 自带双语展示文案；其他异常回退到通用文案。
 * 同一文案复用同一个 blob URL（错误类型是有限集合），由构建者统一释放，
 * 与加载图/未找到图的资源管理方式一致。
 */
export default class FailureImages implements FailureImageSource {
	private urls = new Map<string, string>();

	/** 合法缺失（404 / CID 不匹配）沿用既有「未找到文件」语义 */
	constructor(private readonly notFoundMessage: string) {}

	get notFound(): string {
		return this.urlFor(this.notFoundMessage);
	}

	/** 解析抛错时展示的失败图 */
	forError(error: unknown): string {
		const message =
			error instanceof ResolveURLError
				? localizedText(error.display)
				: t("genericFailure");
		return this.urlFor(message);
	}

	private urlFor(message: string): string {
		const cached = this.urls.get(message);
		if (cached) return cached;
		const url = URL.createObjectURL(
			new Blob([createImagePlaceholderSVG(message, "error")], {
				type: "image/svg+xml",
			}),
		);
		this.urls.set(message, url);
		return url;
	}

	[Symbol.dispose](): void {
		for (const url of this.urls.values()) {
			URL.revokeObjectURL(url);
		}
		this.urls.clear();
	}
}

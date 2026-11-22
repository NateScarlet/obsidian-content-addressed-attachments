/**
 * 页面链接补丁状态机：观察页面 DOM 变动，把 ipfs:// 与锁定链接改写为可访问的资源 URL。
 *
 * 从插件生命周期入口抽出，只暴露 start / dispose；所有外部依赖由构建者注入，
 * 便于在不实例化插件的前提下测试。元素级补丁、有界保序并发与合并通知均复用既有实现。
 */
import type { ResolveURLResult } from "./URLResolver";
import type { FailureImageSource } from "./utils/FailureImages";
import patchElementURL from "./utils/patchElementURLs";
import patchElementBackgroundImage from "./utils/patchElementBackgroundImage";
import { stripWrappedPrefix } from "./utils/wrappedBackgroundImage";
import orderedParallelMap, {
	DEFAULT_PARALLEL_LIMIT,
	EMPTY_PROJECTION,
	drain,
	type OrderedParallelProjection,
} from "./utils/orderedParallelMap";
import showError from "./utils/showError";

/** 失败上报所需的最小接口（生产由 CoalescedNotice 提供） */
export interface PatchFailureReporter {
	report(failures: number): void;
}

export interface PageLinkPatcherOptions {
	/** 把原始链接解析为可访问 URL */
	resolveURL: (rawURL: string) => Promise<ResolveURLResult | undefined>;
	/** 解析期间的占位图 URL */
	placeholder: string;
	/** 合法缺失与解析失败时使用的失败图 */
	failures: FailureImageSource;
	/** 失败计数的合并上报器 */
	notice: PatchFailureReporter;
	/** 被观察的文档（由构建者注入，模块不读取全局 activeDocument） */
	// eslint-disable-next-line obsidianmd/prefer-active-doc -- 注入的观察目标，刻意不使用全局 activeDocument
	document: Document;
}

/** 匹配 ipfs:// 或 internal.ipfs-locked: 前缀（含 http:/// 伪装前缀）的元素 */
const LINK_SELECTOR =
	'[src^="ipfs://"], [href^="ipfs://"], [src^="internal.ipfs-locked:"], [href^="internal.ipfs-locked:"], [src*="http:///ipfs://"], [href*="http:///ipfs://"], [src*="http:///internal.ipfs-locked:"], [href*="http:///internal.ipfs-locked:"]';
/** 匹配 Base 卡片封面中被 http:/// 伪装的 background-image */
const BACKGROUND_IMAGE_SELECTOR =
	'[style*="http:///ipfs://"], [style*="http:///internal.ipfs-locked:"]';

/**
 * HTML 元素判定：按节点自身窗口 realm 的构造器判断，跨窗口仍成立。
 * 文本节点、DocumentFragment、SVG 元素等不算 HTML 元素，不作为补丁根。
 */
function isHTMLElement(node: Node): node is HTMLElement {
	if (node.nodeType !== Node.ELEMENT_NODE) {
		return false;
	}
	const ctor = node.ownerDocument?.defaultView?.HTMLElement;
	// eslint-disable-next-line obsidianmd/prefer-instanceof -- 构造器取自节点自身窗口，已跨窗口安全；测试 DOM 没有 instanceOf 扩展
	return ctor ? node instanceof ctor : false;
}

/** img 元素判定：同样按节点自身窗口 realm 的构造器判断 */
function isImageElement(el: HTMLElement): boolean {
	const ctor = el.ownerDocument?.defaultView?.HTMLImageElement;
	// eslint-disable-next-line obsidianmd/prefer-instanceof -- 构造器取自节点自身窗口，已跨窗口安全；测试 DOM 没有 instanceOf 扩展
	return ctor ? el instanceof ctor : false;
}

export default class PageLinkPatcher implements Disposable {
	private readonly stack = new DisposableStack();
	private readonly inProgressElements = new WeakSet<HTMLElement>();
	/** 元素级补丁共用的占位图与失败图来源 */
	private readonly patchResources: Pick<
		PageLinkPatcherOptions,
		"placeholder" | "failures"
	>;

	constructor(private readonly options: PageLinkPatcherOptions) {
		this.patchResources = {
			placeholder: options.placeholder,
			failures: options.failures,
		};
	}

	/** 连接 observer 并立即扫描一次现有页面 */
	start(): void {
		const observer = this.stack.adopt(
			new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					if (isHTMLElement(mutation.target)) {
						void this.patchLinksIn(mutation.target).catch(
							showError,
						);
					}
					mutation.addedNodes.forEach((node) => {
						if (isHTMLElement(node)) {
							void this.patchLinksIn(node).catch(showError);
						}
					});
				});
			}),
			(i) => i.disconnect(),
		);
		observer.observe(this.options.document.body, {
			childList: true,
			subtree: true,
		});
		// 首屏内容不会触发 observer，启动时主动扫描一次现有页面
		void this.patchLinksIn(this.options.document).catch(showError);
	}

	/** 断开 observer 并释放本模块持有的资源 */
	dispose(): void {
		this.stack.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	/** 在去重守卫下处理元素：同一元素在一次补丁中只处理一次 */
	private async withElementGuard(
		el: HTMLElement,
		patch: () => Promise<void>,
	): Promise<void> {
		if (this.inProgressElements.has(el)) {
			return;
		}
		using stack = new DisposableStack();
		this.inProgressElements.add(el);
		stack.defer(() => this.inProgressElements.delete(el));
		await patch();
	}

	private async processElementURL(el: HTMLElement): Promise<void> {
		await this.withElementGuard(el, async () => {
			for (const attr of ["src", "href"] as const) {
				const value = el.getAttribute(attr);
				if (!value) continue;
				// 检查是否是 IPFS/锁定链接（含 http:/// 伪装前缀的链接）
				const canonical: string = stripWrappedPrefix(value) ?? value;
				if (
					canonical.startsWith("ipfs://") ||
					canonical.startsWith("internal.ipfs-locked:")
				) {
					console.debug("🖼️ 处理 URL:", value);
					await patchElementURL(
						el,
						attr,
						(rawURL) => this.options.resolveURL(rawURL),
						{
							imageFallback: isImageElement(el) && attr === "src",
							...this.patchResources,
						},
					);
				}
			}
		});
	}

	/**
	 * 改写 Base 卡片封面：Base 只接受 http(s) 封面值，因此 IPFS 链接
	 * 以 http:/// 前缀包装保留在 DOM 的 background-image 中，这里剥掉前缀走
	 * 统一解析后写回可访问的资源 URL。异步解析返回后仅当背景图未被组件改掉时才写回。
	 */
	private async processElementBackgroundImage(
		el: HTMLElement,
	): Promise<void> {
		await this.withElementGuard(el, () =>
			patchElementBackgroundImage(
				el,
				(rawURL) => this.options.resolveURL(rawURL),
				this.patchResources,
			),
		);
	}

	private async patchLinksIn(
		parent: ParentNode = this.options.document,
	): Promise<void> {
		const match = parent.querySelectorAll<HTMLElement>(LINK_SELECTOR);
		const backgroundMatch = parent.querySelectorAll<HTMLElement>(
			BACKGROUND_IMAGE_SELECTOR,
		);

		// 有界并发：一次 mutation 可命中大量元素，元素内解析还会触发远程请求，
		// 无上限并发会把页面渲染与网络都打满
		const patches: (() => Promise<void>)[] = [];
		match.forEach((element) => {
			patches.push(() => this.processElementURL(element));
		});
		backgroundMatch.forEach((element) => {
			patches.push(() => this.processElementBackgroundImage(element));
		});

		let failures = 0;
		await drain(
			orderedParallelMap(
				patches,
				async (patch): Promise<OrderedParallelProjection<never>> => {
					try {
						await patch();
					} catch (error) {
						// 元素级隔离：各元素相互独立，一个元素解析失败不应让同批其余元素
						// 停止补丁；失败汇总后以单条防抖 Notice 反馈
						failures += 1;
						console.error("补丁元素 URL 失败", error);
					}
					return EMPTY_PROJECTION;
				},
				{ limit: DEFAULT_PARALLEL_LIMIT },
			),
		);
		if (failures > 0) {
			this.options.notice.report(failures);
		}
	}
}

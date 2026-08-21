import { Notice } from "obsidian";
import validateScriptOutput from "./validateScriptOutput";
import type { PreProcessInput, PreProcessOutput, ScriptLoader } from "./types";

/** 日志通知防抖窗口：窗口内的多条日志合并为单条 Notice（CODING_STANDARDS §3） */
const LOG_BATCH_WINDOW_MS = 500;

/**
 * 预处理管线：将文件通过预处理脚本转换后返回。
 *
 * 管线职责单一：将明文文件转换为另一个明文文件（或返回原始文件）。
 * 加密、CAS 存储和链接插入由调用方负责。
 *
 * 脚本 URL 通过工厂函数获取，确保调用者始终使用最新的配置值。
 */
export default class TransformPipeline {
	/** 等待防抖窗口 flush 的日志 */
	private pendingLogMessages: string[] = [];
	/** 防抖 flush 定时器 id；null 表示当前无挂起窗口 */
	private logFlushTimer: number | null = null;
	/** dispose 后丢弃新日志，避免卸载后仍调度定时器弹出通知 */
	private disposed = false;

	constructor(
		private scriptLoader: ScriptLoader,
		public getScriptURL: () => string,
	) {}

	/**
	 * 立即弹出累积中的日志通知并清理挂起的定时器。
	 * 插件 onunload 时调用，满足资源 100% 回收要求（CODING_STANDARDS §5）；
	 * 之后到达的日志（如仍在途的 run 调用）会被丢弃，不再调度定时器。
	 */
	dispose(): void {
		this.disposed = true;
		if (this.logFlushTimer !== null) {
			window.clearTimeout(this.logFlushTimer);
			this.logFlushTimer = null;
		}
		this.flushPendingLogs();
	}

	/**
	 * 运行预处理管线。
	 * @param input 输入文件信息
	 * @returns 转换后的文件，或 undefined 表示保留原始文件（预处理未启用或脚本显式跳过）
	 * @throws 当配置了预处理脚本但脚本加载失败或脚本执行抛出异常时
	 */
	async run(input: PreProcessInput): Promise<PreProcessOutput | undefined> {
		const scriptURL = this.getScriptURL();
		if (!scriptURL) {
			return undefined;
		}

		const module = await this.scriptLoader.loadScript(scriptURL);
		if (!module) {
			throw new Error(`[preprocess] Failed to load script: ${scriptURL}`);
		}
		// import() 的 ESM 模块命名空间对象不可调用，transform 函数只可能来自 default 导出
		const transformFn =
			typeof module.default === "function" ? module.default : undefined;

		if (!transformFn) {
			throw new Error(
				`[preprocess] Script default export must be a function: ${scriptURL}`,
			);
		}

		const params = this.scriptLoader.getParams(scriptURL);

		const result: PreProcessOutput | undefined = await transformFn(input, {
			log: (message: string) => this.logWithBatchedNotice(message),
			params,
		});

		if (!result) {
			return undefined;
		}

		validateScriptOutput(result, input, scriptURL);

		return {
			data: result.data,
			mimeType: result.mimeType,
			filename: result.filename,
		};
	}

	/** 弹出一条合并了窗口内全部日志的 Notice */
	private flushPendingLogs(): void {
		if (this.pendingLogMessages.length === 0) {
			return;
		}
		const lines = this.pendingLogMessages;
		this.pendingLogMessages = [];
		new Notice(`[preprocess]\n${lines.join("\n")}`);
	}

	/** 窗口内的日志先累积，窗口到期时合并为单条 Notice，避免批量操作刷屏 */
	private logWithBatchedNotice(message: string): void {
		if (this.disposed) {
			return;
		}
		this.pendingLogMessages.push(message);
		if (this.logFlushTimer !== null) {
			return;
		}
		this.logFlushTimer = window.setTimeout(() => {
			this.logFlushTimer = null;
			this.flushPendingLogs();
		}, LOG_BATCH_WINDOW_MS);
	}
}

import { Notice } from "obsidian";
import type {
	PreProcessInput,
	PreProcessOutput,
	PreProcessContext,
	ScriptLoader,
} from "./types";

/**
 * 预处理管线：将文件通过预处理脚本转换后返回。
 *
 * 管线职责单一：将明文文件转换为另一个明文文件（或返回原始文件）。
 * 加密、CAS 存储和链接插入由调用方负责。
 *
 * 脚本 URL 通过工厂函数获取，确保调用者始终使用最新的配置值。
 */
export default class TransformPipeline {
	constructor(
		private scriptLoader: ScriptLoader,
		public getScriptURL: () => string,
	) {}

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
		const rawModule = module as Record<string, unknown>;
		const rawDefault = rawModule.default as
			Record<string, unknown> | undefined;
		const transformFn =
			typeof module.default === "function"
				? module.default
				: typeof rawDefault?.default === "function"
					? (rawDefault.default as (
							input: PreProcessInput,
							ctx: PreProcessContext,
						) =>
							| Promise<PreProcessOutput | undefined>
							| PreProcessOutput
							| undefined)
					: typeof module === "function"
						? (module as (
								input: PreProcessInput,
								ctx: PreProcessContext,
							) =>
								| Promise<PreProcessOutput | undefined>
								| PreProcessOutput
								| undefined)
						: undefined;

		if (!transformFn) {
			throw new Error(
				`[preprocess] Script default export must be a function: ${scriptURL}`,
			);
		}

		const params = this.scriptLoader.getParams(scriptURL);

		const result: PreProcessOutput | undefined = await transformFn(input, {
			log: (message: string) => new Notice(`[preprocess] ${message}`),
			params,
		});

		if (!result) {
			return undefined;
		}

		return {
			data: result.data,
			mimeType: result.mimeType || input.mimeType,
			filename: result.filename || input.filename,
		};
	}
}

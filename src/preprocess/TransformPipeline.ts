import { Notice } from "obsidian";
import mimeTypeByExtension from "#src/utils/mimeTypeByExtension";
import type { PreProcessInput, PreProcessOutput, ScriptLoader } from "./types";

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
		private getScriptURL: () => string,
	) {}

	/**
	 * 运行预处理管线。
	 * @param input 输入文件信息
	 * @returns 转换后的文件，或 undefined 表示保留原始文件
	 */
	async run(input: PreProcessInput): Promise<PreProcessOutput | undefined> {
		const scriptURL = this.getScriptURL();
		if (!scriptURL) {
			return undefined;
		}

		const module = await this.scriptLoader.loadScript(scriptURL);
		if (!module?.default) {
			return undefined;
		}

		const params = this.scriptLoader.getParams(scriptURL);

		try {
			const result = await module.default(input, {
				log: (message) => new Notice(`[preprocess] ${message}`),
				params,
				mimeTypeByExtension,
			});

			if (result === undefined) {
				return undefined;
			}

			return {
				data: result.data,
				mimeType: result.mimeType || input.mimeType,
				filename: result.filename || input.filename,
			};
		} catch (err) {
			console.warn(
				`[preprocess] Script transform failed for ${input.filename}:`,
				err,
			);
			new Notice(
				`[preprocess] Script transform failed for ${input.filename}: ${(err as Error).message}`,
			);
			return undefined;
		}
	}
}

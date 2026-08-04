import mimeTypeByExtension from "#src/utils/mimeTypeByExtension";
import type {
	PreProcessInput,
	PreProcessOutput,
	ScriptLoader,
} from "./types";

/**
 * 预处理管线：将文件通过预处理脚本转换后返回。
 *
 * 管线职责单一：将明文文件转换为另一个明文文件（或返回原始文件）。
 * 加密、CAS 存储和链接插入由调用方负责。
 */
export default class TransformPipeline {
	constructor(private scriptLoader: ScriptLoader) {}

	/**
	 * 运行预处理管线。
	 * @param input 输入文件信息
	 * @param scriptURL 预处理脚本 URL，空字符串表示禁用
	 * @returns 转换后的文件，或 undefined 表示保留原始文件
	 */
	async run(
		input: PreProcessInput,
		scriptURL: string,
	): Promise<PreProcessOutput | undefined> {
		if (!scriptURL) {
			// 未配置脚本，跳过预处理
			return undefined;
		}

		const module = await this.scriptLoader.loadScript(scriptURL);
		if (!module?.default) {
			// 脚本加载失败或无默认导出，保留原始文件
			return undefined;
		}

		const params = this.scriptLoader.getParams(scriptURL);

		try {
			const result = await module.default(input, {
				log: (...args) => console.log("[preprocess]", ...args),
				params,
				mimeTypeByExtension,
			});

			if (result === undefined) {
				// 脚本决定保留原始文件
				return undefined;
			}

			// 确保返回结果有合法的 mimeType
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
			// 脚本抛出异常，保留原始文件
			return undefined;
		}
	}
}
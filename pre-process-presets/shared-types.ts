/**
 * 预设脚本共享类型定义。
 *
 * 插件端和脚本端共享这些接口定义，确保类型一致。
 * 自定义实现也可以复制此文件作为参考。
 */

/** 预处理脚本的输入文件 */
export interface PreProcessInput {
	/** 文件原始二进制数据 */
	data: ArrayBuffer;
	/** 文件的 MIME 类型 */
	mimeType: string;
	/** 文件名 */
	filename: string;
}

/** 预处理脚本的上下文 */
export interface PreProcessContext {
	/** 日志函数 */
	log: (message: string) => void;
	/** 从 URL fragment 解析的参数 */
	params: URLSearchParams;
	/** 根据文件扩展名获取 MIME 类型 */
	mimeTypeByExtension: (ext: string) => string;
}

/** 预处理脚本的输出 */
export interface PreProcessOutput {
	/** 转换后的文件二进制数据 */
	data: ArrayBuffer;
	/** 转换后的 MIME 类型 */
	mimeType: string;
	/** 转换后的文件名 */
	filename: string;
}

/** 预处理脚本的模块导出约定 */
export interface PreProcessScriptModule {
	/** 默认导出驱动管线，返回 undefined 表示保留原始文件 */
	default?: (
		input: PreProcessInput,
		ctx: PreProcessContext,
	) => Promise<PreProcessOutput | undefined> | PreProcessOutput | undefined;
}

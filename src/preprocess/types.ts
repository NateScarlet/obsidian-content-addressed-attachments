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
	log: (...args: unknown[]) => void;
	/** 从 URL fragment 解析的参数键值对 */
	params: Record<string, string>;
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

/** 预处理配置 */
export interface PreProcessConfig {
	/** 脚本 URL，空字符串表示禁用预处理 */
	scriptURL: string;
}

/** 预设索引条目 */
export interface PresetEntry {
	/** 友好名称 */
	name: string;
	/** 描述 */
	description: string;
	/** internal.ipfs-locked URL */
	scriptURL: string;
}

/** 脚本位置解析结果 */
export type ScriptLocation =
	| { type: "vault-relative"; path: string; params: Record<string, string> }
	| {
			type: "internal.ipfs-locked";
			cid: string;
			sourceURL: string;
			params: Record<string, string>;
	  }
	| { type: "ipfs"; cid: string; params: Record<string, string> }
	| { type: "https"; url: string; params: Record<string, string> };

/** 脚本加载器接口，用于依赖注入 */
export interface ScriptLoader {
	/** 加载脚本模块，返回模块实例或 undefined */
	loadScript(scriptURL: string): Promise<PreProcessScriptModule | undefined>;
	/** 获取参数 */
	getParams(scriptURL: string): Record<string, string>;
	/** 锁定 HTTPS URL 为 internal.ipfs-locked，返回新 URL 或 undefined */
	lockHTTPSURL(
		url: string,
	): Promise<{ lockedURL: string; module: PreProcessScriptModule } | undefined>;
}
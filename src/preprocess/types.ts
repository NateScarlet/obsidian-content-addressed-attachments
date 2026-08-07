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

/** 预处理配置 */
export interface PreProcessConfig {
	/** 脚本 URL，空字符串表示禁用预处理 */
	scriptURL: string;
}

/** 脚本索引条目 */
export interface ScriptIndexEntry {
	/** 友好名称 */
	name: string;
	/** 描述 */
	description: string;
	/** internal.ipfs-locked URL */
	scriptURL: string;
}

/** 脚本位置解析结果 */
export type ScriptLocation =
	| { type: "vault-relative"; path: string; params: URLSearchParams }
	| {
			type: "internal.ipfs-locked";
			cid: string;
			sourceURL: string;
			params: URLSearchParams;
	  }
	| { type: "ipfs"; cid: string; params: URLSearchParams }
	| { type: "http"; url: string; params: URLSearchParams };

/**
 * 多文件预设清单中的单个文件来源描述。
 * 由 CID 唯一标识，可选提供多个下载源。
 */
export interface ManifestFileSource {
	/** 内容地址（vault CID），用于防篡改验证 */
	cid: string;
	/** 非 IPFS 下载候选（如 https），按顺序尝试，每个会验证 CID */
	sources?: string[];
}

/**
 * 多文件脚本清单。
 * 当脚本 URL 指向的内容以 `{` 开头时，视为 JSON 清单。
 * 加载器会将所有文件下载到 `<pluginDir>/preprocess-scripts/<cid>/` 目录下，
 * 然后加载入口文件。
 */
export interface ScriptManifest {
	/** 入口文件名（必须是 files 中的一个 key） */
	entry: string;
	/** 文件名 → 文件来源映射 */
	files: Record<string, ManifestFileSource>;
}

/** 脚本加载器接口，用于依赖注入 */
export interface ScriptLoader {
	/** 加载脚本模块，返回模块实例或 undefined */
	loadScript(scriptURL: string): Promise<PreProcessScriptModule | undefined>;
	/** 获取参数 */
	getParams(scriptURL: string): URLSearchParams;
}

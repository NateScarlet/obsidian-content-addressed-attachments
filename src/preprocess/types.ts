import type { LocalizedText } from "../utils/localizedText";
import type {
	PreProcessInput,
	PreProcessContext,
	PreProcessOutput,
	PreProcessScriptModule,
} from "./shared-types";

export type {
	PreProcessInput,
	PreProcessContext,
	PreProcessOutput,
	PreProcessScriptModule,
};

/** 脚本索引条目 */
export interface ScriptIndexEntry {
	/** 友好名称 */
	name: string;
	/** 描述（中英双语，按用户界面语言显示） */
	description: LocalizedText;
	/** internal.ipfs-locked URL */
	scriptURL: string;
}

/** 多文件预设清单中的单个文件来源描述。
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
	/** 清空已加载模块缓存 */
	clearCache(): void;
}

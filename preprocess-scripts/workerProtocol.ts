/**
 * 主脚本与转换 Worker 共享的消息协议形状。
 * 仅类型定义：两侧由 esbuild 分别打包，type-only 导入在编译后擦除。
 */

import type {
	PreProcessInput,
	PreProcessOutput,
} from "../src/preprocess/shared-types";

/** convert 请求 */
export interface ConvertRequest {
	type: "convert";
	id: number;
	input: PreProcessInput;
	format: string;
	quality: number;
	/** magick.wasm 的绝对 URL（主脚本解析；worker 内 import.meta.url 是 blob 无相对路径） */
	wasmURL: string;
}

/** convert 响应 */
export interface ConvertResponse {
	type: "result";
	id: number;
	output?: PreProcessOutput;
	error?: string;
}

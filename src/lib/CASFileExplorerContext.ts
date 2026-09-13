import { createContext } from "svelte";
import type { App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";
import type EncryptionService from "./encryption/EncryptionService";

export enum Mode {
	LOCAL,
	ACTIVE_NOTE,
	UNREFERENCED,
	RECYCLE_BIN,
}

export interface CASFileExplorerContext {
	// 依赖
	cas: CAS;
	casMetadata: CASMetadata;
	referenceManager: ReferenceManager;
	app: App;
	encryptionService: EncryptionService;

	// 状态
	mode: { value: Mode };
	query: { value: string };

	/**
	 * 主存储目录（存在 ipfs:// 引用的文件恢复目标）。
	 * 以函数形式提供，保证与当前设置实时一致。
	 */
	getPrimaryDir: () => string;
	/** 下载目录列表（仅锁定引用的文件恢复目标）。以函数形式提供，保证与当前设置实时一致。 */
	getDownloadDirs: () => string[];

	/**
	 * 元数据写入专用中止信号：插件卸载时中止进行中的批量写入，
	 * 避免插件多版本竞争写入同一 IndexedDB
	 */
	metadataWriteSignal: AbortSignal;

	fetchMore: (signal?: AbortSignal) => Promise<void>;
}

export const [getContext, setContext] = createContext<CASFileExplorerContext>();

import type { CID } from "multiformats";
import type { CASMetadataObject } from "./CASMetadata";
import type { Stat } from "obsidian";

export interface CAS {
	formatRelPath(cid: CID): string;
	formatNormalizePath(dir: string, cid: CID): string;
	trash(cid: CID): Promise<number>;
	/**
	 * 从回收站恢复。restoreAllowedDirs 为允许恢复落盘的目录列表：
	 * 副本所在目录不在列表内时迁移到列表第一个目录；
	 * 列表为空或未提供时原位恢复（现行为）。
	 */
	restoreIfTrashed(cid: CID, restoreAllowedDirs?: string[]): Promise<boolean>;
	load(
		cid: CID,
		restoreAllowedDirs?: string[],
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined>;
	save(dir: string, file: File): Promise<{ cid: CID; didCreate: boolean }>;
	deleteIfTrashed(cid: CID): Promise<number>;
	objects(): AsyncIterableIterator<CASMetadataObject>;
	/** 索引元数据，使其和实际一致 */
	index(meta: CASMetadataObject): Promise<void>;
	lookup(cid: CID): AsyncIterableIterator<{
		dir: string;
		path: string;
		stat: Stat;
		isTrashed: boolean;
	}>;
}

import type { CID } from "multiformats";
import type { CASMetadataObject } from "./CASMetadata";
import type { Stat } from "obsidian";

/**
 * 写入新副本前的准入回调：上层注入写入策略（如下载目录配额自动清理），
 * CASImpl 只负责在真正落盘前调用它，不认识策略本身。
 * size 为即将落盘的新副本字节数，供策略为它腾出空间。
 */
export type CASWriteGuard = (dir: string, size: number) => Promise<void>;

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
	/**
	 * 收集某 CID 在所有目录的副本状态（含回收站副本）。
	 * 供后台索引追平按磁盘真相重建副本状态；这是磁盘探测，不依赖元数据库。
	 */
	collectCopies(cid: CID): Promise<{ dir: string; trashedAt?: Date }[]>;
	save(dir: string, file: File): Promise<{ cid: CID; didCreate: boolean }>;
	deleteIfTrashed(cid: CID): Promise<number>;
	/**
	 * 删除某 CID 在指定目录的正常副本，并按磁盘真相重算该 CID 的副本集合。
	 * 同目录的回收站副本与其他目录的副本都不受影响。
	 * 副本删净后按 isReferenced 决定记录去留：仍被引用则保留记录并清空副本状态
	 * （等待重新获取），无引用则删除记录。
	 * @returns 是否真的删除了物理文件（磁盘上已无此副本时返回 false，不改元数据）
	 */
	deleteCopyInDir(
		cid: CID,
		dir: string,
		isReferenced: (cid: CID) => Promise<boolean>,
	): Promise<boolean>;
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

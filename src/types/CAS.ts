import type { CID } from "multiformats";
import type { CASMetadataObject } from "./CASMetadata";
import type { Stat } from "obsidian";

/**
 * 写入新副本前的准入回调：上层注入写入策略（如下载目录配额自动清理），
 * CASImpl 只负责在真正落盘前调用它，不认识策略本身。
 * size 为即将落盘的新副本字节数，供策略为它腾出空间。
 */
export type CASWriteGuard = (dir: string, size: number) => Promise<void>;

/** 目录遍历命中的单个副本：其 CID、规范化路径与磁盘 stat */
export interface CASDirCopy {
	cid: CID;
	path: string;
	stat: Stat;
}

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
	 * 直接遍历指定目录的正常副本（`dir/XX/{cid}.data`），逐个产出其 CID、
	 * 规范化路径与磁盘 stat。不查元数据库，也不碰其它目录与回收站副本。
	 * 分片目录与分片内的文件都按随机顺序产出：清理只需遍历一次，顺序不携带信息，
	 * 随机化可避免单个报错文件在多次清理中反复卡住同一批副本。
	 */
	walkDirCopies(dir: string): AsyncIterableIterator<CASDirCopy>;
	/**
	 * 删除某 CID 在指定目录的正常副本。其它目录的副本与同目录的回收站副本不受影响。
	 * 删后仅发布失效信号，元数据由后台消费者按磁盘真相对账，本方法不读写元数据。
	 * @returns 是否真的删除了物理文件（磁盘上已无此副本时返回 false）
	 */
	removeCopyInDir(cid: CID, dir: string): Promise<boolean>;
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

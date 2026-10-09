import type { CID } from "multiformats";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import formatFileSize from "#src/utils/formatFileSize";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CleanDownloadDirResult {
	/** 实际删除的副本数 */
	deleted: number;
	/** 实际释放的字节数 */
	freedBytes: number;
}

export interface CleanDownloadDirOptions {
	/** 目标目录列表；手动清理传单个目录，自动清理传全部下载目录 */
	dirs: string[];
	/** 保留期（天，允许小数）；≤0 表示全部副本可删 */
	retentionDays: number;
	/**
	 * 需要释放的字节数：不提供则删到无可删为止（手动清理）。
	 * 自动清理传入「超出配额的部分 + 本次写入的体积」，按创建时间从最旧开始删，
	 * 累计释放达标即停。
	 */
	freeBytes?: number;
	/** 引用判定：副本删净时据此决定保留还是删除元数据记录 */
	isReferenced: (cid: CID) => Promise<boolean>;
	/** 中止信号：插件卸载时中止进行中的枚举与删除 */
	signal: AbortSignal;
}

/**
 * 清理下载目录中创建时间超过保留期的副本。
 *
 * 候选来自元数据（按目录筛选的正常副本），因此只覆盖被索引收录的 CAS 副本：
 * 未知命名格式的文件与外部直接拷入的文件既不会被删除，也不计入释放量。
 * 创建时间取自磁盘文件修改时间——CAS 内容不可变，落盘后修改时间不再变化，
 * 等价于该副本的创建时刻（与回收时间同一来源，见 CONTEXT）。
 *
 * 删除按引用状态一概执行：被笔记引用的副本同样删除（ADR-0005），
 * 引用关系的去留由 `cas.deleteCopyInDir` 依据 isReferenced 判定。
 */
export default async function cleanDownloadDir(
	cas: CAS,
	casMetadata: CASMetadata,
	options: CleanDownloadDirOptions,
	onProgress?: (deleted: number, cidStr: string) => void,
): Promise<CleanDownloadDirResult> {
	const { dirs, retentionDays, freeBytes, isReferenced, signal } = options;
	// 保留期为 0 表示全部副本可删（刚落盘、年龄恰为 0 的副本仍算保留期内）；
	// 负值同样按 0 处理。边界取「未达保留期」：恰好到达保留期的副本不删除。
	const cutoff = Date.now() - Math.max(0, retentionDays) * MS_PER_DAY;
	let deleted = 0;
	let freedBytes = 0;

	for (const dir of dirs) {
		if (freeBytes != null && freedBytes >= freeBytes) {
			break;
		}
		signal.throwIfAborted();
		// 该目录内超保留期的正常副本，按创建时间升序（最旧先删）
		const candidates: { cid: CID; createdAt: number; size: number }[] = [];
		for await (const { node } of casMetadata.find({
			filterBy: { hasCopyInDirs: [dir] },
			signal,
		})) {
			const createdAt = await copyCreatedAt(cas, node.cid, dir);
			if (createdAt != null && createdAt < cutoff) {
				candidates.push({
					cid: node.cid,
					createdAt,
					size: node.size ?? 0,
				});
			}
		}
		candidates.sort((a, b) => a.createdAt - b.createdAt);

		for (const { cid, size } of candidates) {
			if (freeBytes != null && freedBytes >= freeBytes) {
				break;
			}
			signal.throwIfAborted();
			if (await cas.deleteCopyInDir(cid, dir, isReferenced)) {
				deleted += 1;
				// 释放量取自删除前的元数据：唯一副本删净且无引用时记录会被一并删除
				freedBytes += size;
				onProgress?.(deleted, cid.toString());
			}
		}
	}
	return { deleted, freedBytes };
}

export interface EnforceDownloadQuotaOptions {
	/** 即将写入的目录；非下载目录的写入不牵涉下载目录占用 */
	targetDir: string;
	/** 全部下载目录（空列表表示无需检查） */
	downloadDirs: string[];
	/** 配额字节；≤0 表示不启用自动清理 */
	quotaBytes: number;
	/** 即将写入的新副本字节数：为它腾出空间后才算落到配额内 */
	incomingBytes: number;
	/** 保留期（天） */
	retentionDays: number;
	isReferenced: (cid: CID) => Promise<boolean>;
	signal: AbortSignal;
}

export interface EnforceDownloadQuotaResult {
	/** 是否触发过清理 */
	didClean: boolean;
	/**
	 * 清理后连同本次写入仍超过配额：保留期内的副本不可删除，此时照常写入，
	 * 由调用方合并提示用户。
	 */
	didExceedQuota: boolean;
	/** 清理前的下载目录合计占用 */
	usedBytes: number;
	/** 实际释放的字节数 */
	freedBytes: number;
}

/**
 * 写入新副本前的配额检查：全部下载目录占用合计超过配额时先清理再写入。
 *
 * 占用取自元数据维护的按目录统计（O(1) 读取），未超配额时不枚举副本，
 * 因此这里的常态开销只是一次统计读取。超配额时按「超出配额 + 本次写入」的量
 * 清理，不追求删净；无可删副本时放弃清理，调用方照常写入。
 */
export async function enforceDownloadQuota(
	cas: CAS,
	casMetadata: CASMetadata,
	options: EnforceDownloadQuotaOptions,
): Promise<EnforceDownloadQuotaResult> {
	const {
		targetDir,
		downloadDirs,
		quotaBytes,
		incomingBytes,
		retentionDays,
		isReferenced,
		signal,
	} = options;
	if (quotaBytes <= 0 || !downloadDirs.includes(targetDir)) {
		return {
			didClean: false,
			didExceedQuota: false,
			usedBytes: 0,
			freedBytes: 0,
		};
	}
	const { dirBytes } = await casMetadata.estimateStorage();
	const usedBytes = downloadDirs.reduce(
		(sum, dir) => sum + (dirBytes[dir] ?? 0),
		0,
	);
	// 本次写入后要落回配额内，缺口含新副本自身
	const excessBytes = usedBytes + incomingBytes - quotaBytes;
	if (excessBytes <= 0) {
		return {
			didClean: false,
			didExceedQuota: false,
			usedBytes,
			freedBytes: 0,
		};
	}

	const { freedBytes } = await cleanDownloadDir(cas, casMetadata, {
		dirs: downloadDirs,
		retentionDays,
		freeBytes: excessBytes,
		isReferenced,
		signal,
	});
	return {
		didClean: true,
		didExceedQuota: freedBytes < excessBytes,
		usedBytes,
		freedBytes,
	};
}

/**
 * 读取某 CID 在指定目录的正常副本的创建时间；磁盘上无此副本时返回 undefined。
 */
async function copyCreatedAt(
	cas: CAS,
	cid: CID,
	dir: string,
): Promise<number | undefined> {
	for await (const match of cas.lookup(cid)) {
		if (match.dir === dir && !match.isTrashed) {
			return match.stat.mtime;
		}
	}
	return undefined;
}

/**
 * 清理的常驻提示与结果反馈：文件管理器的清理按钮旁与设置页的配额项旁共用
 * cleanupWarning——清理不可逆，界面上必须常驻可见（ADR-0005）。
 */
export const cleanDownloadDirMessages = {
	en: {
		cleanupWarning:
			"Cleaning permanently deletes copies older than the retention period, including copies still referenced by notes. If the source goes offline, those files cannot be fetched again.",
		cleaned: (deleted: number, freedBytes: number) =>
			`Cleaned ${deleted} file(s), freed ${formatFileSize(freedBytes)}`,
	},
	zh: {
		cleanupWarning:
			"清理会永久删除超过保留期的副本，包括仍被笔记引用的副本。源站一旦下线，这些文件将无法再获取。",
		cleaned: (deleted: number, freedBytes: number) =>
			`已清理 ${deleted} 个文件，释放 ${formatFileSize(freedBytes)}`,
	},
};

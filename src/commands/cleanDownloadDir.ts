import type { CAS, CASDirCopy } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import orderedParallelMap, {
	DEFAULT_PARALLEL_LIMIT,
	EMPTY_PROJECTION,
	type OrderedParallelProject,
} from "#src/utils/orderedParallelMap";
import formatFileSize from "#src/utils/formatFileSize";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CleanDownloadDirResult {
	/** 实际删除的副本数 */
	deleted: number;
	/** 实际释放的字节数 */
	freedBytes: number;
}

/** 删除成功后交回主循环计数的结果：释放量取自删除前读到的磁盘 stat */
interface RemovedCopy {
	size: number;
	cidStr: string;
}

export interface CleanDownloadDirOptions {
	/** 目标目录列表；手动清理传单个目录，自动清理传全部下载目录 */
	dirs: string[];
	/** 保留期（天，允许小数）；≤0 表示全部副本可删 */
	retentionDays: number;
	/**
	 * 需要释放的字节数：不提供则删到无可删为止（手动清理）。
	 * 自动清理传入「超出配额的部分 + 本次写入的体积」，累计释放达标即停。
	 */
	freeBytes?: number;
	/** 中止信号：插件卸载时中止进行中的遍历与删除 */
	signal: AbortSignal;
}

/**
 * 清理下载目录中创建时间超过保留期的副本。
 *
 * 候选直接来自目标目录的遍历（`cas.walkDirCopies`），不查元数据库：目录里有多少
 * 文件就做多少次 stat，与元数据表的规模无关，因此万级副本的清理仍是秒级。
 * 遍历只认 CAS 命名约定（`dir/XX/{cid}.data`），未知命名格式的文件与外部直接拷入的
 * 文件既不会被删除，也不计入释放量——与旧路径一致。
 * 创建时间取自磁盘文件修改时间——CAS 内容不可变，落盘后修改时间不再变化，
 * 等价于该副本的创建时刻（与回收时间同一来源，见 CONTEXT）。
 *
 * 删除按引用状态一概执行：被笔记引用的副本同样删除（ADR-0005）。副本状态不在此处
 * 收敛，`cas.removeCopyInDir` 只发布失效信号，由后台索引按磁盘真相对账。
 *
 * 释放量达标即提前结束遍历：并发删除下最多还有 `limit` 个副本在飞、其结果不会被
 * 交付（见 ADR-0006），因此返回值是「已被交付的删除」的下界，比实际删掉的少至多
 * `limit` 个。
 */
export default async function cleanDownloadDir(
	cas: CAS,
	options: CleanDownloadDirOptions,
	onProgress?: (deleted: number, cidStr: string) => void,
): Promise<CleanDownloadDirResult> {
	const { dirs, retentionDays, freeBytes, signal } = options;
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
		// 删除以受限并发进行：磁盘 IO 延迟是主要成本，串行下万级副本耗时以分钟计。
		// 投影只做删除，把结果交回主循环计数——并发计数若写在投影里，返回后仍在变化。
		// 单个副本删除失败会向上抛出并中止本次清理，随机遍历顺序使下次清理卡在别处。
		const deleteExpired: OrderedParallelProject<
			CASDirCopy,
			RemovedCopy
		> = async (copy) => {
			if (copy.stat.mtime >= cutoff) {
				return EMPTY_PROJECTION;
			}
			if (!(await cas.removeCopyInDir(copy.cid, dir))) {
				return EMPTY_PROJECTION;
			}
			// 释放量取自删除前读到的 stat，不依赖元数据记录是否收录了这份副本
			return [{ size: copy.stat.size, cidStr: copy.cid.toString() }];
		};
		// 遍历是随机的，不按创建时间排序：清理只需遍历一次，
		// 随机顺序可避免单个报错文件反复卡住同一批副本
		for await (const removed of orderedParallelMap(
			cas.walkDirCopies(dir),
			deleteExpired,
			{ limit: DEFAULT_PARALLEL_LIMIT, signal },
		)) {
			deleted += 1;
			freedBytes += removed.size;
			onProgress?.(deleted, removed.cidStr);
			// 释放量达标即停：在飞的删除无法取消，略微超出无妨，
			// 超出的副本同样是超保留期的可删副本
			if (freeBytes != null && freedBytes >= freeBytes) {
				break;
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
 * 占用取自元数据维护的按目录统计（O(1) 读取），未超配额时不遍历目录，
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

	const { freedBytes } = await cleanDownloadDir(cas, {
		dirs: downloadDirs,
		retentionDays,
		freeBytes: excessBytes,
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
 * 清理的常驻提示与结果反馈：文件管理器的清理按钮旁与设置页的配额项旁共用
 * cleanupWarning——清理不可逆，界面上必须常驻可见（ADR-0005）。
 * cleaned 的文件数带「≥」：并发删除下仍有副本在飞、其结果未被交付，
 * 报出的数字是实际清理量的下界（ADR-0006）。
 */
export const cleanDownloadDirMessages = {
	en: {
		cleanupWarning:
			"Cleaning permanently deletes copies older than the retention period, including copies still referenced by notes. If the source goes offline, those files cannot be fetched again.",
		cleaned: (deleted: number, freedBytes: number) =>
			`Cleaned ≥ ${deleted} file(s) (${formatFileSize(freedBytes)})`,
	},
	zh: {
		cleanupWarning:
			"清理会永久删除超过保留期的副本，包括仍被笔记引用的副本。源站一旦下线，这些文件将无法再获取。",
		cleaned: (deleted: number, freedBytes: number) =>
			`清理了 ≥ ${deleted} 文件（${formatFileSize(freedBytes)}）`,
	},
};

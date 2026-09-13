import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";

export interface CleanUnreferencedResult {
	/** 实际回收（移入回收站）的文件数 */
	cleaned: number;
}

export interface CleanUnreferencedProgress {
	/**
	 * index 为回收阶段已移动文件数。判定/筛选（含 ensureFresh 与逐条引用计数）
	 * 由 casMetadata.find 的 hasReference 筛选内置完成，命令层不再单独报告"扫描"阶段。
	 */
	(index: number, cidStr: string, phase: "cleaning"): void;
}

export interface CleanUnreferencedOptions {
	/** 中止信号：必填，插件卸载等场景必须能中止进行中的清理 */
	signal: AbortSignal;
}

/**
 * 清理未引用文件：复用引用筛选，流式取回"未引用且未进回收站"的元数据并移入回收站。
 *
 * 前置缓存保证由 hasReference 筛选内部的 ensureFresh 完成——增量扫描 + 外部删除对账后
 * 缓存条目即真相，引用判定才可信任缓存（skipVerify）。判定与回收对同一 cid 保持原子。
 *
 * 并发由数据层 orderedParallelFilter 承担（保序 + 引用计数批合并），命令层不再自研 worker 池。
 *
 * 进度：回收阶段每移入一个文件回调一次（cleaning）。
 */
export default async function cleanUnreferenced(
	cas: CAS,
	casMetadata: CASMetadata,
	onProgress: CleanUnreferencedProgress | undefined,
	options: CleanUnreferencedOptions,
): Promise<CleanUnreferencedResult> {
	const { signal } = options;
	let cleaned = 0;

	// hasReference 筛选内部含 ensureFresh；isTrashed:false 与"未引用"页口径一致
	const iterator = casMetadata.find({
		filterBy: { hasReference: false, isTrashed: false },
		signal,
	});
	for await (const { node } of iterator) {
		signal.throwIfAborted();
		// 计数以 trash 的实际移动数为准：磁盘无副本（trash 只删元数据记录）
		// 或仅有回收站副本（无物理移动）时返回 0，不计入「已移动」
		const moved = await cas.trash(node.cid);
		cleaned += moved;
		if (moved > 0) {
			onProgress?.(cleaned, node.cid.toString(), "cleaning");
		}
	}
	return { cleaned };
}

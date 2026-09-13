import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";

export interface CleanUnreferencedResult {
	/** 引用检查覆盖的元数据条数 */
	scanned: number;
	/** 实际回收（移入回收站）的文件数 */
	cleaned: number;
}

export interface CleanUnreferencedProgress {
	/**
	 * index 为该阶段自己的计数：scanning=已检查条数，cleaning=已移动文件数。
	 * 两个阶段由调用方渲染为独立进度条，各显示各的语义，互不混合。
	 */
	(index: number, cidStr: string, phase: "scanning" | "cleaning"): void;
}

export interface CleanUnreferencedOptions {
	/** 中止信号：必填，插件卸载等场景必须能中止进行中的清理 */
	signal: AbortSignal;
}

/** 消费元数据流的并行度上限：条目间无依赖，并行使引用查询在时间上重叠 */
const CONCURRENCY = 8;

/**
 * 清理未引用文件：流式遍历全部元数据，逐条做引用检查，未引用的移入回收站。
 *
 * 前置缓存保证（skipVerify 契约）：进入消费流之前先 ensureFresh——
 * 增量扫描 + 外部删除对账，保证后缓存条目即真相，引用判定才可信任缓存
 * （skipVerify: true）。未做保证就跳过验证会在缓存过时时误判未引用并误删。
 *
 * 消费侧有界并行：检查与回收的条目之间无依赖，固定并发上限并行消费，
 * 使引用查询请求在时间上重叠（数据层内部的请求合并依赖此堆积）。
 * 同一 cid 的检查与回收保持原子（先检查后回收），不同 cid 并行不破坏不变量。
 *
 * 进度分两阶段回调：
 * - scanning：引用检查阶段，每检查一条回调一次（并行下按完成序回调）；
 * - cleaning：回收阶段，每回收一条回调一次。
 */
export default async function cleanUnreferenced(
	cas: CAS,
	casMetadata: CASMetadata,
	referenceManager: ReferenceManager,
	onProgress: CleanUnreferencedProgress | undefined,
	options: CleanUnreferencedOptions,
): Promise<CleanUnreferencedResult> {
	const { signal } = options;
	// skipVerify 契约：判定前必须完成缓存保证
	await referenceManager.ensureFresh(signal);
	let scanned = 0;
	let cleaned = 0;

	// 元数据游标不支持并发 continue：单一迭代者按序拉取，分配给并行 worker
	const iterator = casMetadata.find({ filterBy: {}, signal });
	const next = async (): Promise<CASMetadataObject | undefined> => {
		const result = await iterator.next();
		if (result.done) {
			return undefined;
		}
		return result.value.node;
	};

	const processOne = async (node: CASMetadataObject) => {
		const isReferenced =
			(await referenceManager.count(node.cid, 1, signal, {
				skipVerify: true,
			})) > 0;
		scanned++;
		onProgress?.(scanned, node.cid.toString(), "scanning");
		if (isReferenced) {
			return;
		}
		// 计数以 trash 的实际移动数为准：磁盘无副本（trash 只删元数据记录）
		// 或仅有回收站副本（无物理移动）时返回 0，不计入「已移动」
		const moved = await cas.trash(node.cid);
		cleaned += moved;
		if (moved > 0) {
			onProgress?.(cleaned, node.cid.toString(), "cleaning");
		}
	};

	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			signal.throwIfAborted();
			const node = await next();
			if (node === undefined) {
				return;
			}
			await processOne(node);
		}
	});
	await Promise.all(workers);
	return { scanned, cleaned };
}

import { CID } from "multiformats";
import type ContentAddressedAttachmentPlugin from "./main";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import { ReferenceManagerCacheImpl } from "./infrastructure/indexed-db/ReferenceManagerCache";
import findIPFSLinks, { type IPFSLinkMatch } from "./utils/findIPFSLinks";
import IPFSLink from "./utils/IPFSLink";
import isAbortError from "./utils/isAbortError";
import orderedParallelMap, {
	DEFAULT_PARALLEL_LIMIT,
	EMPTY_PROJECTION,
	drain,
	type OrderedParallelProjection,
} from "./utils/orderedParallelMap";
import { Notice, TFile } from "obsidian";
import { mount, unmount } from "svelte";
import IncrementalScanProgress from "#src/lib/IncrementalScanProgress.svelte";
import { getDownloadDirs } from "#src/settings";
import restoreReferencedFiles from "./commands/restoreReferencedFiles";
import pruneDeletedPaths from "./ReferenceManager/pruneDeletedPaths";
import CoalescingBatch from "#src/utils/CoalescingBatch";

/** 请求合并的批上限：防积压场景下批无限膨胀与早到请求等待过久（max 非 min） */
const COALESCING_BATCH_MAX_SIZE = 64;

/**
 * 批归属键：合并只应用于相同验证语义的请求——
 * skipVerify 与默认验证的调用方对结果的正确性前提不同，不共享批。
 */
function batchKeyOf(skipVerify: boolean): string {
	return skipVerify ? "skipVerify" : "verify";
}

/**
 * 增量扫描的并发上限：同时是合并批宽。取值须显著大于普通并发上限，
 * 使同批到达的元数据写入能合并为少量读写事务（万级文件时保持事务数远小于文件数）；
 * 又不能大到一次性启动过多读取任务打满内存与 IO。
 */
const INCREMENTAL_SCAN_LIMIT = 64;

export interface ReferenceManagerCache {
	add(
		cid: CID,
		normalizedPath: string,
		signal: AbortSignal | undefined,
	): Promise<void>;
	find(
		cid: CID,
		signal: AbortSignal | undefined,
	): AsyncIterableIterator<string>;
	findBatch(
		cids: CID[],
		signal: AbortSignal | undefined,
	): Promise<Map<string, { cid: string; normalizedPath: string }[]>>;
	expireByPath(
		normalizedPath: string,
		lastUpdatedBefore: Date,
		signal: AbortSignal | undefined,
	): Promise<number>;
	cachedPaths(signal?: AbortSignal): Promise<Set<string>>;
	removeByPaths(paths: string[], signal?: AbortSignal): Promise<number>;
	cutoffAt(signal: AbortSignal | undefined): Promise<Date>;
	setCutoffAt(v: Date, signal: AbortSignal | undefined): Promise<void>;
}

export interface ReferenceCountOptions {
	/**
	 * 跳过逐条笔记内容验证、直接信任缓存条目。
	 * 仅当调用方已确保引用缓存对当前 vault 状态最新（如元数据引用过滤器
	 * 构建时刚完成缓存保证）时才可传 true；默认 false 保留验证，
	 * 零散调用在缓存可能过时时仍返回正确数据。
	 */
	skipVerify?: boolean;
}

/** 增量扫描进度的可注入报告器：生产用 Notice+svelte，测试注入空实现即可避免依赖 DOM */
export interface IncrementalScanReporter {
	begin(total: number): IncrementalScanReporterHandle;
}
export interface IncrementalScanReporterHandle {
	update(index: number, file: string): void;
	finish(): void;
}

let nextID = 0;

export default class ReferenceManager {
	cache: ReferenceManagerCache;
	flight = new SingleFlightGroup();

	private readonly incrementalScanReporter: IncrementalScanReporter;
	/** 本类默认构建的引用缓存（注入的缓存不记录，由注入者负责清理） */
	private readonly builtCache: ReferenceManagerCacheImpl | undefined;
	/** 后台索引任务（增量扫描等）共享的中止信号：构建时创建，dispose（卸载/热重载）时 abort 取消 */
	private readonly scanController = new AbortController();

	constructor(
		private plugin: ContentAddressedAttachmentPlugin,
		/** 可注入依赖：cache 供测试用内存实现；incrementalScanReporter 供测试注入空实现避免 DOM */
		options: {
			cache?: ReferenceManagerCache;
			incrementalScanReporter?: IncrementalScanReporter;
		} = {},
	) {
		if (options.cache) {
			this.cache = options.cache;
		} else {
			this.cache = this.builtCache = new ReferenceManagerCacheImpl();
		}
		this.incrementalScanReporter =
			options.incrementalScanReporter ?? defaultIncrementalScanReporter;
	}

	/**
	 * 构建者负责清理：先取消后台索引任务，再关闭本类默认构建的引用缓存连接；
	 * 注入的 cache 由注入者清理，不在此处理。
	 */
	[Symbol.dispose](): void {
		this.scanController.abort();
		this.builtCache?.[Symbol.dispose]();
	}

	async count(
		cid: CID,
		limit: number,
		signal: AbortSignal | undefined,
		options: ReferenceCountOptions = {},
	): Promise<number> {
		if (limit == 0) {
			return 0;
		}
		// skipVerify：缓存保证已由调用方完成，条目存在即被引用（limit 1 只判存在性）
		if (options.skipVerify) {
			const entries = await this.mergedEntryCount(cid, signal);
			return Math.min(entries, limit);
		}
		let count = 0;
		for await (const path of this.findFilePath(cid, signal)) {
			void path;
			count += 1;
			if (count == limit) {
				return count;
			}
		}
		return count;
	}

	private pendingBatches = new Map<string, CoalescingBatch<CID, number>>();

	/**
	 * 经请求合并的缓存条目计数：并行到达的查询挂靠同一批，
	 * 一个只读事务批量取回（零积压零等待语义，见 CoalescingBatch）。
	 * 请求合并依赖调用侧的并行消费堆积——顺序逐条 await 时批内永远只有自己，
	 * 等价于未合并（行为正确，仅无合并收益）。
	 * 按验证语义（skipVerify/verify）分队列；同 cid 多 waiter 经合并键共享一次查询。
	 */
	private mergedEntryCount(
		cid: CID,
		signal: AbortSignal | undefined,
	): Promise<number> {
		const key = batchKeyOf(true);
		let batch = this.pendingBatches.get(key);
		if (!batch) {
			batch = new CoalescingBatch<CID, number>(
				(cids, sig) => this.queryEntryCounts(cids, sig),
				COALESCING_BATCH_MAX_SIZE,
				this.scanController.signal,
				{ keyOf: (c) => c.toString() },
			);
			this.pendingBatches.set(key, batch);
		}
		return batch.join(cid, signal);
	}

	/** 一次只读事务批量取回一批 cid 的引用条目数（结果与输入逐项对齐） */
	private async queryEntryCounts(
		cids: CID[],
		signal: AbortSignal | undefined,
	): Promise<number[]> {
		const entriesMap = await this.cache.findBatch(cids, signal);
		return cids.map((cid) => entriesMap.get(cid.toString())?.length ?? 0);
	}

	async *findFilePath(
		cid: CID,
		signal: AbortSignal | undefined,
		options?: { skipVerify?: boolean },
	): AsyncIterableIterator<string> {
		const prefix = `ipfs://${cid.toString()}`;
		const prefix2 = `internal.ipfs-locked:${cid.toString()},`;
		// TODO: 逐条串行 await 验证（无并发爆炸风险，但全库验证是隐藏的耗时大头），
		// 需要时可改为有界并发的有序原语
		for await (const normalizedPath of this.cache.find(cid, signal)) {
			if (!options?.skipVerify) {
				if (
					!(await this.verifyReference(
						normalizedPath,
						prefix,
						prefix2,
					))
				) {
					// 缓存过时了，后台进行重建（fire-and-forget，不面向调用者结果）
					void this.loadFile(normalizedPath).catch(() => {});
					continue;
				}
			}
			yield normalizedPath;
		}
	}

	private async verifyReference(
		normalizedPath: string,
		prefix: string,
		prefix2: string,
	) {
		const file =
			this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
		if (!(file instanceof TFile)) {
			return false;
		}
		// 引用判定以磁盘为唯一可信源（vault.read），不以 cachedRead 为准（见 CONTEXT.md）
		const content = await this.plugin.app.vault.read(file);
		return content.includes(prefix) || content.includes(prefix2);
	}

	private async incrementalScan() {
		await this.flight.do("scan", () => this.doIncrementalScan());
	}

	/**
	 * 引用缓存新鲜性保证：增量扫描（笔记内容改动）+ 外部删除对账（文件消失）。
	 * 幂等：无改动时近乎零成本。完成后缓存条目即真相，判定可信任缓存
	 * （skipVerify）。实现内部以单飞去重并发触发。
	 */
	ensureFresh(signal: AbortSignal | undefined): Promise<void> {
		return this.flight
			.do("ensureFresh", () => this.doEnsureFresh(signal), signal)
			.then((i) => i.result);
	}

	private async doEnsureFresh(signal: AbortSignal | undefined) {
		await this.incrementalScan();
		const { vault } = this.plugin.app;
		const cachedPaths = await this.cache.cachedPaths(signal);
		if (cachedPaths.size === 0) {
			return;
		}
		const currentPaths = new Set(
			vault.getMarkdownFiles().map((file) => file.path),
		);
		const deleted = pruneDeletedPaths(cachedPaths, currentPaths);
		await this.cache.removeByPaths(deleted, signal);
	}

	private async doIncrementalScan() {
		// 共享构建时的后台中止信号：dispose（卸载/热重载）时 abort 取消扫描，
		// 停止启动新任务、中止在飞写入、关闭进度条。
		const signal = this.scanController.signal;
		try {
			signal.throwIfAborted();
			const cutoffAt = await this.cache.cutoffAt(signal);
			const { vault } = this.plugin.app;
			const startAt = new Date();
			const newFiles = vault
				.getMarkdownFiles()
				.filter((file) => file.stat.mtime >= cutoffAt.getTime());
			if (newFiles.length === 0) {
				return;
			}
			console.debug("[incremental-scan] begin", {
				newFilesCount: newFiles.length,
				cutoffAt,
			});
			const progress = this.incrementalScanReporter.begin(
				newFiles.length,
			);
			try {
				// 有界并发：新装插件的库可能上万新文件，一次性启动等量任务会打满 IO 与内存。
				// 64 同时是并发上限与合并批宽——批宽足够大，同批到达的元数据写入才能被
				// 合并为少量读写事务；取更小值会让写入退回逐条事务量级。
				let index = 0;
				for await (const path of orderedParallelMap(
					newFiles,
					(file) => this.projectFileIndexed(file.path),
					{ limit: INCREMENTAL_SCAN_LIMIT, signal },
				)) {
					// 进度按源顺序推进：序号与文件名一一对应（并发完成序会让两者错位）
					index += 1;
					progress.update(index, path);
					console.debug("[incremental-scan] did update progress", {
						index,
						total: newFiles.length,
					});
				}
			} finally {
				progress.finish();
			}
			await this.cache.setCutoffAt(startAt, signal);
			console.debug("[incremental-scan] did set cutoff", {
				value: startAt,
			});
		} catch (error) {
			// 取消（卸载/热重载）为正常终止：静默返回，进度条已在 finally 关闭，不写 cutoff。
			if (!isAbortError(error)) {
				throw error;
			}
		}
	}

	/**
	 * 增量扫描的投影：索引单个文件后产出其路径，供消费点按源顺序报告进度
	 * （进度序号与文件名必须对应，故由产出顺序而非完成顺序驱动）。
	 */
	private async *projectFileIndexed(
		normalizedPath: string,
	): AsyncGenerator<string> {
		await this.loadFile(normalizedPath);
		yield normalizedPath;
	}

	async loadFile(normalizedPath: string) {
		await this.flight.do(`loadFile:${normalizedPath}`, () =>
			this.doLoadFile(normalizedPath),
		);
	}

	private async doLoadFile(normalizedPath: string) {
		const file =
			this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
		// 索引以磁盘为唯一可信源（vault.read），不以 cachedRead / 编辑器缓冲为准，
		// 避免过时缓存让被引用附件被误判为未引用（见 CONTEXT.md「磁盘为唯一可信源」）。
		// 共享后台中止信号：卸载时取消在飞索引写入。
		await this.loadFileContent(
			normalizedPath,
			file instanceof TFile ? await this.plugin.app.vault.read(file) : "",
			this.scanController.signal,
		);
	}

	/**
	 * 单个链接的索引投影：引用缓存写入 + 元数据索引（两个任务并发入队，
	 * 使它们落入同一注册窗口被合并批合并）。无产出（纯副作用）。
	 */
	private async projectLinkIndex(
		{ url, title }: IPFSLinkMatch,
		normalizedPath: string,
		signal: AbortSignal | undefined,
	): Promise<OrderedParallelProjection<never>> {
		await Promise.all([
			this.cache.add(url.cid, normalizedPath, signal),
			this.plugin.cas.index({
				cid: url.cid,
				indexedAt: new Date(),
				filename: url.filename || title || undefined,
				format: url.format || undefined,
			}),
		]);
		return EMPTY_PROJECTION;
	}

	async loadFileContent(
		normalizedPath: string,
		markdown: string,
		signal?: AbortSignal,
	) {
		const id = `load-${nextID}`;
		nextID++;

		const startAt = new Date();
		const cids: CID[] = [];
		// 触发笔记中以 ipfs:// 形式引用的 cid：恢复时短路判定，无需再查全库
		const knownIPFSCids = new Set<string>();
		const links = [...findIPFSLinks(markdown)];
		for (const { url } of links) {
			cids.push(url.cid);
			if (url instanceof IPFSLink) {
				knownIPFSCids.add(url.cid.toString());
			}
		}
		// 有界并发：单条笔记可解析出大量链接，一次性全部启动会让巨型笔记卡住界面。
		// 每个链接的投影同时发起引用缓存写入与元数据索引两个任务，故在飞写入
		// 至多为 2 × DEFAULT_PARALLEL_LIMIT。
		console.debug("[incremental-scan] will index", {
			id,
			linkCount: links.length,
		});
		await drain(
			orderedParallelMap(
				links,
				(link) => this.projectLinkIndex(link, normalizedPath, signal),
				{ limit: DEFAULT_PARALLEL_LIMIT, signal },
			),
		);
		console.debug("[incremental-scan] will expire by path", { id });
		await this.cache.expireByPath(normalizedPath, startAt, signal);

		if (cids.length > 0) {
			console.debug("[incremental-scan] restore referenced files", {
				id,
				cidCount: cids.length,
			});
			// 在解析出新链接后，自动检查并恢复仍在垃圾箱里的被引用文件
			await restoreReferencedFiles(
				this.plugin.cas,
				this.plugin.casMetadata,
				{
					referenceManager: this,
					primaryDir: this.plugin.settings.primaryDir,
					downloadDirs: getDownloadDirs(this.plugin.settings),
					cids,
					knownIPFSCids,
				},
			);
		}
		console.debug("[incremental-scan] restore referenced files", {
			id,
			cidCount: cids.length,
		});
	}

	async clearCache(signal?: AbortSignal) {
		await this.cache.setCutoffAt(new Date(0), signal);
	}

	async *findReference(cid: CID, signal?: AbortSignal) {
		await this.incrementalScan();
		const { vault } = this.plugin.app;
		for await (const normalizedPath of this.cache.find(cid, signal)) {
			const file = vault.getAbstractFileByPath(normalizedPath);
			if (!(file instanceof TFile)) {
				// fire-and-forget，不面向调用者结果
				void this.loadFile(normalizedPath).catch(() => {});
				continue;
			}
			const markdown = await vault.cachedRead(file);
			for (const link of findIPFSLinks(markdown)) {
				if (link.url.cid.equals(cid)) {
					yield {
						...link,
						file,
					};
				}
			}
		}
	}

	/**
	 * 是否存在 ipfs:// 形式引用（全库、基于已验证引用）。
	 * 仅 internal.ipfs-locked: 锁定引用时返回 false。
	 */
	async hasIPFSReference(cid: CID): Promise<boolean> {
		for await (const { url } of this.findReference(cid)) {
			if (url instanceof IPFSLink) {
				return true;
			}
		}
		return false;
	}
}

/** 生产默认增量扫描报告器：Notice + svelte 进度组件 */
const defaultIncrementalScanReporter: IncrementalScanReporter = {
	begin(total) {
		// 超时 0：进度条在扫描期间保持显示，直到 finish 手动 hide；
		// 默认超时（5s）会让扫描未完成时进度条就自动消失。
		const notice = new Notice(new DocumentFragment(), 0);
		const progress = mount(IncrementalScanProgress, {
			// eslint-disable-next-line @typescript-eslint/no-deprecated, obsidianmd/no-unsupported-api
			target: notice.containerEl ?? notice.noticeEl,
			props: {
				totalFiles: total,
			},
		});
		return {
			update: (index, file) => {
				progress.currentIndex = index;
				progress.currentFile = file;
			},
			finish: () => {
				void unmount(progress);
				notice.hide();
			},
		};
	},
};

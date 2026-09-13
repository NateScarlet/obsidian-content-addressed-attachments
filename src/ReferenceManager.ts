import { CID } from "multiformats";
import type ContentAddressedAttachmentPlugin from "./main";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import { ReferenceManagerCacheImpl } from "./infrastructure/indexed-db/ReferenceManagerCache";
import findIPFSLinks from "./utils/findIPFSLinks";
import IPFSLink from "./utils/IPFSLink";
import { Notice, TFile } from "obsidian";
import { mount, unmount } from "svelte";
import IncrementalScanProgress from "#src/lib/IncrementalScanProgress.svelte";
import { getDownloadDirs } from "#src/settings";
import restoreReferencedFiles from "./commands/restoreReferencedFiles";
import pruneDeletedPaths from "./ReferenceManager/pruneDeletedPaths";
import {
	batchKeyOf,
	shouldExecuteImmediately,
	type BatchState,
} from "./ReferenceManager/mergeBatchPolicy";

/** 请求合并的批上限：防积压场景下批无限膨胀与早到请求等待过久（max 非 min） */
const MERGE_BATCH_MAX_SIZE = 64;

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

export default class ReferenceManager {
	cache: ReferenceManagerCache;
	flight = new SingleFlightGroup();
	private readonly incrementalScanReporter: IncrementalScanReporter;
	/** 本类默认构建的引用缓存（注入的缓存不记录，由注入者负责清理） */
	private readonly builtCache: ReferenceManagerCacheImpl | undefined;

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
	 * 构建者负责清理：只关闭本类默认构建的引用缓存连接；
	 * 注入的 cache 由注入者清理，不在此处理。
	 */
	[Symbol.dispose](): void {
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

	private pendingBatches = new Map<string, ReferenceLookupBatch>();

	/**
	 * 经请求合并的缓存条目计数：并行到达的查询挂靠同一批，
	 * 一个只读事务批量取回（零积压零等待语义，见 mergeBatchPolicy）。
	 * 请求合并依赖调用侧的并行消费堆积——顺序逐条 await 时批内永远只有自己，
	 * 等价于未合并（行为正确，仅无合并收益）。
	 */
	private mergedEntryCount(
		cid: CID,
		signal: AbortSignal | undefined,
	): Promise<number> {
		const key = batchKeyOf(true);
		let batch = this.pendingBatches.get(key);
		if (!batch || shouldExecuteImmediately(batch, MERGE_BATCH_MAX_SIZE)) {
			if (batch) {
				// 达到上限：立即收割当前批，为后续请求开新批
				this.pendingBatches.delete(key);
				void batch.execute(this.cache, signal);
			}
			batch = this.openBatch(key);
		}
		return batch.join(cid, signal);
	}

	private openBatch(key: string): ReferenceLookupBatch {
		const batch = new ReferenceLookupBatch();
		this.pendingBatches.set(key, batch);
		// 收割：注册窗口在当前微任务链结束（下一个宏任务前）闭合。
		// IDB 事务过不了宏任务，注册窗口天然被截断；无积压时窗口内
		// 只有发起请求本身，立即执行（零 minWait）。
		queueMicrotask(() => {
			if (this.pendingBatches.get(key) === batch) {
				this.pendingBatches.delete(key);
				void batch.execute(this.cache, undefined);
			}
		});
		return batch;
	}

	async *findFilePath(
		cid: CID,
		signal: AbortSignal | undefined,
		options?: { skipVerify?: boolean },
	): AsyncIterableIterator<string> {
		const prefix = `ipfs://${cid.toString()}`;
		const prefix2 = `internal.ipfs-locked:${cid.toString()},`;
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
		const cutoffAt = await this.cache.cutoffAt(undefined);
		const { vault } = this.plugin.app;
		const startAt = new Date();
		const newFiles = vault
			.getMarkdownFiles()
			.filter((file) => file.stat.mtime >= cutoffAt.getTime());
		if (newFiles.length === 0) {
			return;
		}
		const progress = this.incrementalScanReporter.begin(newFiles.length);
		try {
			const jobs: Promise<void>[] = [];
			let nextIndex = 1;
			for (const file of newFiles) {
				jobs.push(
					this.loadFile(file.path).then(() => {
						const index = nextIndex;
						nextIndex += 1;
						progress.update(index, file.path);
					}),
				);
			}
			await Promise.all(jobs);
		} finally {
			progress.finish();
		}
		await this.cache.setCutoffAt(startAt, undefined);
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
		await this.loadFileContent(
			normalizedPath,
			file instanceof TFile ? await this.plugin.app.vault.read(file) : "",
		);
	}

	async loadFileContent(
		normalizedPath: string,
		markdown: string,
		signal?: AbortSignal,
	) {
		const startAt = new Date();
		const jobs: Promise<void>[] = [];
		const cids: CID[] = [];
		// 触发笔记中以 ipfs:// 形式引用的 cid：恢复时短路判定，无需再查全库
		const knownIPFSCids = new Set<string>();
		for (const { url, title } of findIPFSLinks(markdown)) {
			cids.push(url.cid);
			if (url instanceof IPFSLink) {
				knownIPFSCids.add(url.cid.toString());
			}
			jobs.push(
				this.cache.add(url.cid, normalizedPath, signal),
				this.plugin.cas.index({
					cid: url.cid,
					indexedAt: new Date(),
					filename: url.filename || title || undefined,
					format: url.format || undefined,
				}),
			);
		}
		await Promise.all(jobs);
		await this.cache.expireByPath(normalizedPath, startAt, signal);

		if (cids.length > 0) {
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

/**
 * 引用查询合并批：收集注册窗口内到达的 cid，一个只读事务批量取回后分发。
 * 生命周期：openBatch 创建 → 微任务窗口内 join → 窗口闭合即 execute（一次）；
 * 达到批上限时由 mergedEntryCount 提前 execute 并开新批。
 */
class ReferenceLookupBatch implements BatchState {
	/** 批内请求数（含去重前；合并策略按此判定收割时机） */
	pending = 0;
	private cids = new Set<string>();
	private waiters = new Map<
		string,
		((entries: number, error?: Error) => void)[]
	>();

	join(cid: CID, signal: AbortSignal | undefined): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const onAbort = (): void => {
				signal?.removeEventListener("abort", onAbort);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			const cidStr = cid.toString();
			this.pending++;
			this.cids.add(cidStr);
			const waiters = this.waiters.get(cidStr) ?? [];
			waiters.push((entries, error) => {
				signal?.removeEventListener("abort", onAbort);
				if (error !== undefined) {
					reject(error);
				} else {
					resolve(entries);
				}
			});
			this.waiters.set(cidStr, waiters);
		});
	}

	async execute(
		cache: ReferenceManagerCache,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (this.cids.size === 0) {
			return;
		}
		try {
			const cids = [...this.cids].map((cidStr) => CID.parse(cidStr));
			const entriesMap = await cache.findBatch(cids, signal);
			this.settle((cidStr) => entriesMap.get(cidStr)?.length ?? 0);
		} catch (err) {
			// 批级失败（事务/中止）传播给全部挂靠者，互不拖垮其他批
			const error = err instanceof Error ? err : new Error(String(err));
			this.settle(() => 0, error);
		}
	}

	private settle(entriesOf: (cidStr: string) => number, error?: Error): void {
		for (const [cidStr, waiters] of this.waiters) {
			for (const waiter of waiters) {
				waiter(entriesOf(cidStr), error);
			}
		}
	}
}

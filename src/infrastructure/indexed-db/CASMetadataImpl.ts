import { CID } from "multiformats";
import type {
	CASMetadata,
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "../../types/CASMetadata";
import type CASMetadataObjectFilterBuilder from "#src/CASMetadataObjectFilterBuilder";
import executeIDBRequest from "#src/utils/executeIDBRequest";
import iterateIDBObjectStore from "#src/utils/iterateIDBObjectStore";
import orderedParallelFilter from "#src/utils/orderedParallelFilter";
import { casMetadataDelete, casMetadataSave } from "#src/events";
import CoalescingBatch from "#src/utils/CoalescingBatch";
import { isEqual, uniqBy } from "es-toolkit";

const DB_NAME = "CASMetadata_50c8334bab1a";
const DB_VERSION = 2;
const OBJECTS_STORE_NAME = "objects";
const STATS_STORE_NAME = "stats";
const STATS_KEY = "summary";

/** 合并批的事务大小：批越大单事务越长，1000 兼顾事务时长与事务总数（go 参照 maxBatchSize） */
const COALESCING_BATCH_MAX_SIZE = 1000;

/**
 * 非主键路径过滤的并发上限：一批元素同步启动谓词，使引用计数等异步谓词并发到达、
 * 合并为单个 IndexedDB 事务（避免逐元素 size-1 事务）；上限控制并发的只读事务数。
 */
const PARALLEL_FILTER_LIMIT = 1024;

export class CASMetadataImpl implements CASMetadata {
	private db: Promise<IDBDatabase>;
	/** 内部批执行阶段信号：dispose（卸载/热重载）时 abort 中止在飞事务 */
	private readonly batchController = new AbortController();
	/**
	 * 内部合并批：merge 入队后在同一注册窗口内自动合并为单个读写事务
	 * （go 参照 runInBatch+loop 收集循环，见 CoalescingBatch）。
	 */
	private readonly coalescingBatch = new CoalescingBatch<
		CASMetadataObject,
		{ didCreate: boolean }
	>(
		(objs) => this.executeMergeBatch(objs),
		COALESCING_BATCH_MAX_SIZE,
		this.batchController.signal,
	);

	constructor(private filterBuilder: CASMetadataObjectFilterBuilder) {
		this.db = (() => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				const transaction = (event.target as IDBOpenDBRequest)
					.transaction!;
				const oldVersion = event.oldVersion;

				// 创建主对象存储
				if (!db.objectStoreNames.contains(OBJECTS_STORE_NAME)) {
					const store = db.createObjectStore(OBJECTS_STORE_NAME, {
						keyPath: "cid",
					});
					store.createIndex("indexedAt", ["indexedAt", "cid"], {
						unique: true,
					});
				}

				// 创建统计信息存储
				if (!db.objectStoreNames.contains(STATS_STORE_NAME)) {
					db.createObjectStore(STATS_STORE_NAME, {
						keyPath: "id",
					});
				}

				// v1 → v2：移除 trashedAt 索引。
				// 数据迁移不在此处做：在 versionchange 事务里做游标遍历，
				// 事务在请求排空后立即 inactive，链式遍历会导致 open 永久 pending（卡住）。
				// 改为运行时延迟迁移：decode 时把 v1 遗留 trashedAt 转成占位 copies，
				// merge 保存时再逐步收敛为精确副本状态。
				if (
					oldVersion < 2 &&
					db.objectStoreNames.contains(OBJECTS_STORE_NAME)
				) {
					const store = transaction.objectStore(OBJECTS_STORE_NAME);
					if (store.indexNames.contains("trashedAt")) {
						store.deleteIndex("trashedAt");
					}
				}
			};
			return executeIDBRequest(request, undefined);
		})();
	}

	/**
	 * 关闭 IndexedDB 连接并中止内部批在飞事务。插件卸载时必须调用，否则热重载/重启用例下
	 * 旧连接残留，后续打开（尤其需要版本变更升级时）会被旧连接阻塞而永久 pending，
	 * 表现为所有查询挂起、库目录被占用、进程无法退出。
	 * fire-and-forget：open 尚未 resolve 时在 resolve 后立即关闭。
	 */
	[Symbol.dispose](): void {
		// 中止内部批执行阶段（多版本竞争写同一 IndexedDB 的窗口关闭）
		this.batchController.abort();
		void this.db.then((db) => db.close());
	}

	async estimateStorage(signal?: AbortSignal): Promise<{
		normalBytes: number;
		trashBytes: number;
	}> {
		const db = await this.db;
		const transaction = db.transaction([STATS_STORE_NAME], "readonly");
		const store = transaction.objectStore(STATS_STORE_NAME);

		const stats = await executeIDBRequest(
			store.get(STATS_KEY) as IDBRequest<Stats | undefined>,
			signal,
		);
		return stats || { normalBytes: 0, trashBytes: 0 };
	}

	private async tx<T>(
		mode: IDBTransactionMode,
		cb: (ctx: {
			store: IDBObjectStore;
			recordChange: (newValue?: PO, oldValue?: PO) => void;
		}) => Promise<T>,
		signal: AbortSignal | undefined,
	): Promise<T> {
		const db = await this.db;
		const transaction = db.transaction(
			[OBJECTS_STORE_NAME, STATS_STORE_NAME],
			mode,
		);

		const changes: { newValue?: PO; oldValue?: PO }[] = [];
		function recordChange(newValue?: PO, oldValue?: PO) {
			changes.push({ newValue, oldValue });
		}

		try {
			const res = await cb({
				store: transaction.objectStore(OBJECTS_STORE_NAME),
				recordChange,
			});

			// 如果有变更，更新统计信息
			if (changes.length > 0) {
				await this.updateStats(
					transaction.objectStore(STATS_STORE_NAME),
					changes,
					signal,
				);
			}

			transaction.commit();
			return res;
		} catch (err) {
			transaction.abort();
			throw err;
		}
	}

	private async updateStats(
		statsStore: IDBObjectStore,
		changes: { newValue?: PO; oldValue?: PO }[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		const currentStats = (await executeIDBRequest(
			statsStore.get(STATS_KEY) as IDBRequest<Stats | undefined>,
			signal,
		)) || { id: STATS_KEY, normalBytes: 0, trashBytes: 0 };

		let normalBytesDelta = 0;
		let trashBytesDelta = 0;

		for (const change of changes) {
			const { newValue, oldValue } = change;

			// 处理旧值的移除
			if (oldValue) {
				const size = oldValue.size || 0;
				if (isTrashedPO(oldValue)) {
					trashBytesDelta -= size;
				} else {
					normalBytesDelta -= size;
				}
			}

			// 处理新值的添加
			if (newValue) {
				const size = newValue.size || 0;
				if (isTrashedPO(newValue)) {
					trashBytesDelta += size;
				} else {
					normalBytesDelta += size;
				}
			}
		}
		if (normalBytesDelta === 0 && trashBytesDelta === 0) {
			return;
		}

		// 更新统计
		currentStats.normalBytes = Math.max(
			0,
			currentStats.normalBytes + normalBytesDelta,
		);
		currentStats.trashBytes = Math.max(
			0,
			currentStats.trashBytes + trashBytesDelta,
		);

		await executeIDBRequest(statsStore.put(currentStats), signal);
	}

	async get(
		cid: CID,
		signal?: AbortSignal,
	): Promise<CASMetadataObject | undefined> {
		return this.tx(
			"readonly",
			async ({ store }) => {
				const po = await executeIDBRequest(
					store.get(cid.toString()) as IDBRequest<PO | undefined>,
					signal,
				);
				if (po) {
					return this.decode(po);
				}
			},
			signal,
		);
	}

	/**
	 * 单条合并：入队内部合并批（go 参照 runInBatch+loop），并发到达的 merge
	 * 在同一注册窗口内自动合并为一个读写事务。调用者 signal 只在收集阶段生效
	 * （已 aborted 不入队）；执行阶段由内部后台信号控制（dispose 时中止），
	 * 不支持调用者取消。
	 */
	async merge(obj: CASMetadataObject, signal?: AbortSignal) {
		return this.coalescingBatch.join(obj, signal);
	}

	/**
	 * 内部批执行器：一个读写事务内按序逐 op get→put（同批同 cid 不去重，
	 * 后到者覆盖先到者），统计只在块末汇总一次；每块提交后对每个变更对象
	 * 派发 casMetadataSave（与单条 merge 语义一致，didChange 才派发）。
	 */
	private async executeMergeBatch(
		objs: CASMetadataObject[],
	): Promise<{ didCreate: boolean }[]> {
		const results = await this.tx(
			"readwrite",
			async ({ store, recordChange }) => {
				const batchResults: {
					didCreate: boolean;
					didChange: boolean;
					after: PO;
				}[] = [];
				for (const obj of objs) {
					const cidStr = obj.cid.toString();
					const existing = await executeIDBRequest(
						store.get(cidStr) as IDBRequest<PO | undefined>,
						this.batchController.signal,
					);
					// 兼容 v1 遗留：无 copies 但有 trashedAt 时按占位副本处理，
					// 保证回收站状态可读出；正常读取（decode）亦做同样归一化
					const existingPO = existing
						? normalizePOForStaleV1(existing)
						: undefined;
					const po = buildMergedPO(this.encode(obj), existingPO);
					if (existingPO && po.copies !== undefined) {
						// 归一化后旧对象可能含 trashedAt，需与 po 对齐才能正确判定无变更且收敛旧数据
						const existingNorm = {
							...existingPO,
							copies: po.copies,
						};
						if (isEqual(existingNorm, po)) {
							batchResults.push({
								didCreate: false,
								didChange: false,
								after: existingPO,
							});
							continue;
						}
					}
					recordChange(po, existingPO);
					await executeIDBRequest(
						store.put(po),
						this.batchController.signal,
					);
					batchResults.push({
						didCreate: !existingPO,
						didChange: true,
						after: po,
					});
				}
				return batchResults;
			},
			this.batchController.signal,
		);
		for (const result of results) {
			if (result.didChange) {
				casMetadataSave.dispatch({
					detail: this.decode(result.after),
				});
			}
		}
		return results.map(({ didCreate }) => ({ didCreate }));
	}

	async delete(cid: CID, signal?: AbortSignal): Promise<void> {
		const existing = await this.tx(
			"readwrite",
			async ({ store, recordChange }) => {
				const cidStr = cid.toString();
				const existing = await executeIDBRequest(
					store.get(cidStr) as IDBRequest<PO | undefined>,
					signal,
				);
				if (!existing) {
					return;
				}
				recordChange(undefined, existing); // 记录删除
				await executeIDBRequest(store.delete(cidStr), signal);
				return existing;
			},
			signal,
		);
		if (existing) {
			casMetadataDelete.dispatch({ detail: this.decode(existing) });
		}
	}

	async *find({
		signal,
		filterBy = {},
		after,
	}: {
		signal: AbortSignal | undefined;
		filterBy?: CASMetadataObjectFilters;
		after?: string;
	}): AsyncIterableIterator<{ node: CASMetadataObject; cursor: string }> {
		if (filterBy.cid?.length === 0) {
			// 筛选条件排除了所有对象，直接返回
			return;
		}
		const db = await this.db;
		const filter = this.filterBuilder.build(filterBy);
		if (filterBy.cid) {
			// 优化：直接基于主键查询
			let cids = uniqBy(filterBy.cid, (i) => i.toString());
			if (after) {
				const index = cids.findIndex((i) => i.toString() === after);
				if (index < 0) {
					// 在非法位置查询，视为不匹配所有对象
					return;
				}
				cids = cids.slice(index + 1);
			}

			for (const cid of cids) {
				const obj = await this.get(cid, signal);
				if (obj && (await filter(obj))) {
					yield {
						node: obj,
						cursor: obj.cid.toString(),
					};
				}
				signal?.throwIfAborted();
			}
			return;
		}

		for await (const edge of orderedParallelFilter(
			iterateIDBObjectStore({
				signal,
				after,
				open: async (afterCursor) => {
					const tx = db.transaction(OBJECTS_STORE_NAME, "readonly");
					const store = tx.objectStore(OBJECTS_STORE_NAME);
					const after = afterCursor
						? this.parseCursor(afterCursor)
						: undefined;
					const index = store.index("indexedAt");
					const cursor = await executeIDBRequest(
						index.openCursor(
							after
								? IDBKeyRange.upperBound(
										[after.indexedAt, after.cid],
										true,
									)
								: null,
							"prev",
						),
						signal,
					);
					return {
						cursor,
						close: () => {
							tx.abort();
						},
					};
				},
				decode: (data: PO) => {
					const node = this.decode(data);
					const cursor = this.createCursor(node.indexedAt, node.cid);
					return {
						node,
						cursor,
					};
				},
			}),
			// 保序并发过滤：谓词并行执行但按源顺序产出，触发引用计数批合并
			async (edge) => filter(edge.node),
			{ signal, limit: PARALLEL_FILTER_LIMIT },
		)) {
			yield edge;
		}
	}

	private createCursor(indexedAt: Date, cid: CID): string {
		return `${indexedAt.getTime().toString(36)},${cid.toString()}`;
	}

	private parseCursor(cursor: string): { indexedAt: number; cid: string } {
		const [indexedAtStr, cid] = cursor.split(",");
		return {
			indexedAt: Number.parseInt(indexedAtStr, 36),
			cid,
		};
	}

	private encode(obj: CASMetadataObject): PO {
		return {
			...obj,
			cid: obj.cid.toString(),
			indexedAt: obj.indexedAt.getTime(),
			lastVisitedAt: obj.lastVisitedAt?.getTime(),
			copies: obj.copies?.map((c) => ({
				dir: c.dir,
				trashedAt: c.trashedAt?.getTime(),
			})),
		};
	}

	private decode(po: PO): CASMetadataObject {
		const norm = normalizePOForStaleV1(po);
		return {
			...norm,
			cid: CID.parse(norm.cid),
			indexedAt: new Date(norm.indexedAt),
			lastVisitedAt: norm.lastVisitedAt
				? new Date(norm.lastVisitedAt)
				: undefined,
			copies: norm.copies?.map((c) => ({
				dir: c.dir,
				trashedAt: c.trashedAt ? new Date(c.trashedAt) : undefined,
			})),
		};
	}
}

/**
 * 归一化 v1 遗留数据：无 copies 但有 trashedAt 的记录按占位副本处理，
 * 并移除 trashedAt 字段。为纯函数（不写回），供 decode 与 merge 统一使用。
 */
export function normalizePOForStaleV1(po: PO): PO {
	if (po.copies !== undefined) {
		return po;
	}
	if (po.trashedAt == null) {
		return po;
	}
	return {
		...po,
		copies: [{ dir: PLACEHOLDER_DIR, trashedAt: po.trashedAt }],
		trashedAt: undefined,
	};
}

/** 持久化对象是否处于回收站（任一目录副本被回收） */
function isTrashedPO(po: PO): boolean {
	// 兼容 v1 遗留：仅有 trashedAt（未归一化）时同样视为回收
	const norm = normalizePOForStaleV1(po);
	return norm.copies?.some((c) => c.trashedAt != null) ?? false;
}

/**
 * 迁移占位副本的目录标识：v1→v2 升级时旧 `trashedAt` 无法定位原始目录，
 * 用空字符串目录占位，保守表示该 CID 可能存在于未知目录的回收站副本。
 */
const PLACEHOLDER_DIR = "";

/**
 * 清理迁移占位副本：一旦出现真实目录副本（dir 非空），即移除占位。
 * 占位仅在没有任何真实目录信息时保留，避免无限期驻留不精确的回收站状态。
 * 由 merge 在所有写入必经路径调用，调用方无需（也不应）感知此迁移细节。
 */
export function removePlaceholderCopies(
	copies: { dir: string; trashedAt?: number }[],
): { dir: string; trashedAt?: number }[] {
	const hasRealCopy = copies.some((c) => c.dir !== PLACEHOLDER_DIR);
	if (!hasRealCopy) {
		return copies;
	}
	const filtered = copies.filter((c) => c.dir !== PLACEHOLDER_DIR);
	return filtered.length === copies.length ? copies : filtered;
}

/**
 * 保留既有回收时间：磁盘上能读到的只有文件修改时间，而 CAS 内容不可变，
 * 它恒早于该副本真正进入回收站的时刻；应用内回收时记录的精确时间只存在于元数据。
 * 因此对回收中的副本实例，已有回收时间时以既有值为准，
 * 只有元数据里没有该副本（库外移入回收站）才采用传入的时间。
 *
 * 按目录匹配即可：每个目录的回收实例至多一条（副本实例以「目录 + 是否回收」为键去重），
 * 故目录与回收实例一一对应。
 */
function keepExistingTrashedAt(
	incoming: { dir: string; trashedAt?: number }[],
	existing: { dir: string; trashedAt?: number }[] | undefined,
): { dir: string; trashedAt?: number }[] {
	if (!existing?.length) {
		return incoming;
	}
	const known = new Map<string, number>();
	for (const c of existing) {
		if (c.trashedAt != null) {
			known.set(c.dir, c.trashedAt);
		}
	}
	if (known.size === 0) {
		return incoming;
	}
	return incoming.map((c) => {
		if (c.trashedAt == null) {
			return c;
		}
		const knownTrashedAt = known.get(c.dir);
		return knownTrashedAt != null
			? { dir: c.dir, trashedAt: knownTrashedAt }
			: c;
	});
}

/**
 * 合并持久化对象（merge 的必经写入路径，所有更新都经由此处）。
 * - partial 更新（index/save/重建索引）可能缺失字段：index 进不来 size，
 *   重建索引进不来 filename/format，缺失时保留既有值，避免覆盖丢失。
 * - copies 未显式提供时保留已有副本状态，并提供时统一清理迁移占位副本。
 * - 副本集合以传入（磁盘）为准，但回收时间沿用既有值（见 keepExistingTrashedAt）。
 */
export function buildMergedPO(incoming: PO, existingPO: PO | undefined): PO {
	if (!existingPO) {
		return incoming;
	}
	const po: PO = { ...incoming };
	po.indexedAt = existingPO.indexedAt;
	po.format = po.format ?? existingPO.format;
	po.filename = po.filename ?? existingPO.filename;
	po.size = po.size ?? existingPO.size;
	if (po.copies === undefined) {
		po.copies = existingPO.copies;
	}
	if (po.copies !== undefined) {
		po.copies = removePlaceholderCopies(
			keepExistingTrashedAt(po.copies, existingPO.copies),
		);
	}
	return po;
}

interface PO {
	cid: string;
	indexedAt: number;
	filename?: string;
	format?: string;
	size?: number;
	lastVisitedAt?: number;
	copies?: { dir: string; trashedAt?: number }[];
	// v1 遗留字段：升级时不主动改写数据（避免卡住），读取时兼容为占位副本
	trashedAt?: number;
}

interface Stats {
	normalBytes: number;
	trashBytes: number;
}

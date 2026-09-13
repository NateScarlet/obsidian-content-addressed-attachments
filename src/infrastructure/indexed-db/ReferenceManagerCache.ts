import { CID } from "multiformats";
import { referenceChange } from "#src/events";
import type { ReferenceManagerCache } from "#src/ReferenceManager";
import executeIDBRequest from "#src/utils/executeIDBRequest";
import iterateIDBObjectStore from "#src/utils/iterateIDBObjectStore";

const DB_NAME = "ReferenceCache_0f072df56a17";
const DB_VERSION = 1;
const STORE_REFERENCES = "references";
const STORE_META = "meta";

/** 批量查询中单个 cid 的扫描上限：count 场景只需知道存在性，防御异常膨胀 */
const FIND_BATCH_SCAN_LIMIT = 128;

export class ReferenceManagerCacheImpl implements ReferenceManagerCache {
	private db: Promise<IDBDatabase>;

	constructor() {
		this.db = (() => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// 创建引用存储
				if (!db.objectStoreNames.contains(STORE_REFERENCES)) {
					const store = db.createObjectStore(STORE_REFERENCES, {
						keyPath: ["cid", "normalizedPath"],
					});
					store.createIndex(
						"path",
						["normalizedPath", "lastUpdatedAt"],
						{ unique: false },
					);
				}

				// 创建元数据存储
				if (!db.objectStoreNames.contains(STORE_META)) {
					db.createObjectStore(STORE_META, { keyPath: "key" });
				}
			};
			return executeIDBRequest(request, undefined);
		})();
	}

	/**
	 * 关闭 IndexedDB 连接（具体实现方法，接口不要求所有实现提供）。
	 * 由构建者（默认路径下为 ReferenceManager）负责调用；注入的替换实现由注入者清理。
	 * fire-and-forget：open 尚未 resolve 时在 resolve 后立即关闭。
	 */
	[Symbol.dispose](): void {
		void this.db.then((db) => db.close());
	}

	private async tx<T>(
		mode: IDBTransactionMode,
		storeNames: string[],
		cb: (stores: Map<string, IDBObjectStore>) => Promise<T>,
	): Promise<T> {
		const db = await this.db;
		const transaction = db.transaction(storeNames, mode);
		const stores = new Map(
			storeNames.map((name) => [name, transaction.objectStore(name)]),
		);

		try {
			const res = await cb(stores);
			transaction.commit();
			return res;
		} catch (err) {
			transaction.abort();
			throw err;
		}
	}

	async add(
		cid: CID,
		normalizedPath: string,
		signal?: AbortSignal,
	): Promise<void> {
		const { didCreate } = await this.tx(
			"readwrite",
			[STORE_REFERENCES],
			async (stores) => {
				const store = stores.get(STORE_REFERENCES)!;
				const po: ReferencePO = {
					cid: cid.toString(),
					normalizedPath,
					lastUpdatedAt: Date.now(),
				};
				const existing = await executeIDBRequest(
					store.count([po.cid, po.normalizedPath]),
					signal,
				);
				await executeIDBRequest(store.put(po), signal);
				return {
					didCreate: !existing,
				};
			},
		);
		if (didCreate) {
			referenceChange.dispatch({
				detail: {
					action: "add",
					cid,
					path: normalizedPath,
				},
			});
		}
	}

	async *find(cid: CID, signal?: AbortSignal): AsyncIterableIterator<string> {
		const db = await this.db;

		for await (const edge of iterateIDBObjectStore({
			open: async (after) => {
				const tx = db.transaction([STORE_REFERENCES], "readonly");
				const store = tx.objectStore(STORE_REFERENCES);
				const index = store;
				const cidStr = cid.toString();
				const cursor = await executeIDBRequest(
					index.openCursor(
						IDBKeyRange.bound(
							[cidStr, after ?? ""],
							[cidStr + "\x00"],
							true,
							true,
						),
					),
					signal,
				);
				return {
					cursor,
					close: () => tx.abort(),
				};
			},
			decode: (po: ReferencePO) => {
				return {
					node: po,
					cursor: po.normalizedPath,
				};
			},
			signal,
		}))
			yield edge.node.normalizedPath;
	}

	/**
	 * 批量查询一批 cid 的引用条目（实现内部供请求合并使用）：
	 * 单个只读事务内按 cid 主键前缀逐个游标取回，事务推进均为微任务 await。
	 * 返回 cid 字符串 → 该 cid 的引用条目列表（无条目的 cid 不在 Map 中）。
	 * 注意：单个 cid 最多取回 FIND_BATCH_SCAN_LIMIT 条——服务的是
	 * skipVerify 存在性判定（条目有无），不能用于精确计数。
	 */
	async findBatch(
		cids: CID[],
		signal: AbortSignal | undefined,
	): Promise<Map<string, ReferencePO[]>> {
		if (cids.length === 0) {
			return new Map();
		}
		const result = new Map<string, ReferencePO[]>();
		await this.tx("readonly", [STORE_REFERENCES], async (stores) => {
			const store = stores.get(STORE_REFERENCES)!;
			for (const cid of cids) {
				const cidStr = cid.toString();
				const entries: ReferencePO[] = [];
				for (
					let after: string | undefined;
					;
					after = entries[entries.length - 1]?.normalizedPath
				) {
					const cursor = await executeIDBRequest(
						store.openCursor(
							IDBKeyRange.bound(
								[cidStr, after ?? ""],
								[cidStr + "\x00"],
								true,
								true,
							),
						),
						signal,
					);
					if (!cursor) {
						break;
					}
					const po = cursor.value as ReferencePO;
					entries.push(po);
					if (entries.length >= FIND_BATCH_SCAN_LIMIT) {
						break;
					}
				}
				if (entries.length > 0) {
					result.set(cidStr, entries);
				}
			}
		});
		return result;
	}

	async expireByPath(
		normalizedPath: string,
		lastUpdatedBefore: Date,
		signal?: AbortSignal,
	): Promise<number> {
		const changes = await this.tx(
			"readwrite",
			[STORE_REFERENCES],
			async (stores) => {
				const store = stores.get(STORE_REFERENCES)!;
				const index = store.index("path");
				const beforeTime = lastUpdatedBefore.getTime();

				const changes: {
					action: "remove";
					cid: CID;
					path: string;
				}[] = [];
				for (
					let cursor = await executeIDBRequest(
						index.openCursor(
							IDBKeyRange.bound(
								[normalizedPath],
								[normalizedPath + "\x00"],
							),
						),
						signal,
					);
					cursor;
					cursor = await (async function next() {
						cursor.continue();
						return executeIDBRequest(
							cursor.request as IDBRequest<IDBCursorWithValue | null>,
							signal,
						);
					})()
				) {
					const po = cursor.value as ReferencePO;
					if (po.lastUpdatedAt < beforeTime) {
						// 只删除最后更新时间在 before 之前的记录
						await executeIDBRequest(cursor.delete(), signal);
						changes.push({
							action: "remove",
							cid: CID.parse(po.cid),
							path: po.normalizedPath,
						});
					} else {
						break;
					}
				}
				return changes;
			},
		);
		changes.forEach((i) => referenceChange.dispatch({ detail: i }));
		return changes.length;
	}

	async cutoffAt(signal?: AbortSignal): Promise<Date> {
		return await this.tx("readonly", [STORE_META], async (stores) => {
			const store = stores.get(STORE_META)!;
			const meta = await executeIDBRequest(
				store.get("cutoffAt") as IDBRequest<MetaPO | undefined>,
				signal,
			);

			if (meta) {
				return new Date(meta.value);
			}

			// 如果没有设置过 cutoffAt，返回一个很早期的日期
			return new Date(0);
		});
	}

	async setCutoffAt(v: Date, signal?: AbortSignal): Promise<void> {
		await this.tx("readwrite", [STORE_META], async (stores) => {
			const store = stores.get(STORE_META)!;
			const po: MetaPO = {
				key: "cutoffAt",
				value: v.getTime(),
			};
			await executeIDBRequest(store.put(po), signal);
		});
	}

	/** 引用缓存中记录的全部笔记路径（去重），供外部删除对账做差集 */
	async cachedPaths(signal?: AbortSignal): Promise<Set<string>> {
		const db = await this.db;
		const paths = new Set<string>();
		await iterateAllEntries(db, [STORE_REFERENCES], signal, (po) => {
			paths.add((po as ReferencePO).normalizedPath);
			return false;
		});
		return paths;
	}

	/** 清除指向已消失笔记路径的全部缓存条目，返回清除数量 */
	async removeByPaths(
		paths: string[],
		signal?: AbortSignal,
	): Promise<number> {
		if (paths.length === 0) {
			return 0;
		}
		const targets = new Set(paths);
		const db = await this.db;
		const toDelete: ReferencePO[] = [];
		await iterateAllEntries(db, [STORE_REFERENCES], signal, (po) => {
			if (targets.has((po as ReferencePO).normalizedPath)) {
				toDelete.push(po as ReferencePO);
			}
			return false;
		});
		if (toDelete.length === 0) {
			return 0;
		}
		return await this.tx(
			"readwrite",
			[STORE_REFERENCES],
			async (stores) => {
				const store = stores.get(STORE_REFERENCES)!;
				for (const po of toDelete) {
					await executeIDBRequest(
						store.delete([po.cid, po.normalizedPath]),
						signal,
					);
				}
				return toDelete.length;
			},
		);
	}
}

/**
 * 单事务遍历 store 全部条目（游标推进均为同一事务内的微任务 await，
 * 满足 IDB 事务不过宏任务的约束）；回调返回 true 时提前结束。
 */
async function iterateAllEntries(
	db: IDBDatabase,
	storeNames: string[],
	signal: AbortSignal | undefined,
	visit: (po: unknown) => boolean | void,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(storeNames, "readonly");
		tx.oncomplete = () => resolve();
		tx.onerror = () =>
			reject(tx.error ?? new Error("reference cache scan failed"));
		tx.onabort = () =>
			reject(tx.error ?? new Error("reference cache scan aborted"));
		for (const name of storeNames) {
			const cursorRequest = tx.objectStore(name).openCursor();
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) {
					return;
				}
				try {
					if (visit(cursor.value)) {
						return;
					}
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					tx.abort();
					return;
				}
				cursor.continue();
			};
		}
		signal?.throwIfAborted();
	});
}

interface ReferencePO {
	cid: string;
	normalizedPath: string;
	lastUpdatedAt: number;
}

interface MetaPO {
	key: string;
	value: number;
}

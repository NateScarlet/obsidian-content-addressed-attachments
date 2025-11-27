import { CID } from "multiformats";
import { referenceChange } from "src/events";
import type { ReferenceManagerCache } from "src/ReferenceManager";
import executeIDBRequest from "src/utils/executeIDBRequest";
import iterateIDBObjectStore from "src/utils/iterateIDBObjectStore";

const DB_NAME = "ReferenceCache_0f072df56a17";
const DB_VERSION = 1;
const STORE_REFERENCES = "references";
const STORE_META = "meta";

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
				action: "add",
				cid,
				path: normalizedPath,
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
		changes.forEach(referenceChange.dispatch);
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

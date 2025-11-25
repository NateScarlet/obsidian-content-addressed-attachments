import { CID } from "multiformats";
import type {
	CASMetadata,
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "../../types/CASMetadata";
import type CASMetadataObjectFilterBuilder from "src/CASMetadataObjectFilterBuilder";
import executeIDBRequest from "src/utils/executeIDBRequest";
import iterateIDBObjectStore from "src/utils/iterateIDBObjectStore";
import { casMetadataDelete, casMetadataSave } from "src/events";

const DB_NAME = "CASMetadata_50c8334bab1a";
const DB_VERSION = 1;
const OBJECTS_STORE_NAME = "objects";
const STATS_STORE_NAME = "stats";
const STATS_KEY = "summary";

export class CASMetadataImpl implements CASMetadata {
	private db: Promise<IDBDatabase>;

	constructor(private filterBuilder: CASMetadataObjectFilterBuilder) {
		this.db = (() => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// 创建主对象存储
				if (!db.objectStoreNames.contains(OBJECTS_STORE_NAME)) {
					const store = db.createObjectStore(OBJECTS_STORE_NAME, {
						keyPath: "cid",
					});
					store.createIndex("indexedAt", ["indexedAt", "cid"], {
						unique: true,
					});
					store.createIndex("trashedAt", ["trashedAt", "cid"], {
						unique: true,
					});
				}

				// 创建统计信息存储
				if (!db.objectStoreNames.contains(STATS_STORE_NAME)) {
					db.createObjectStore(STATS_STORE_NAME, {
						keyPath: "id",
					});
				}
			};
			return executeIDBRequest(request);
		})();
	}

	async estimateStorage(): Promise<{
		normalBytes: number;
		trashBytes: number;
	}> {
		const db = await this.db;
		const transaction = db.transaction([STATS_STORE_NAME], "readonly");
		const store = transaction.objectStore(STATS_STORE_NAME);

		const stats = await executeIDBRequest(
			store.get(STATS_KEY) as IDBRequest<Stats | undefined>,
		);
		return stats || { normalBytes: 0, trashBytes: 0 };
	}

	private async tx<T>(
		mode: IDBTransactionMode,
		cb: (ctx: {
			store: IDBObjectStore;
			recordChange: (newValue?: PO, oldValue?: PO) => void;
		}) => Promise<T>,
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
	): Promise<void> {
		const currentStats = (await executeIDBRequest(
			statsStore.get(STATS_KEY) as IDBRequest<Stats | undefined>,
		)) || { id: STATS_KEY, normalBytes: 0, trashBytes: 0 };

		let normalBytesDelta = 0;
		let trashBytesDelta = 0;

		for (const change of changes) {
			const { newValue, oldValue } = change;

			// 处理旧值的移除
			if (oldValue) {
				const size = oldValue.size || 0;
				if (oldValue.trashedAt != null) {
					trashBytesDelta -= size;
				} else {
					normalBytesDelta -= size;
				}
			}

			// 处理新值的添加
			if (newValue) {
				const size = newValue.size || 0;
				if (newValue.trashedAt != null) {
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

		await executeIDBRequest(statsStore.put(currentStats));
	}

	async get(cid: CID): Promise<CASMetadataObject | undefined> {
		return this.tx("readonly", async ({ store }) => {
			const po = await executeIDBRequest(
				store.get(cid.toString()) as IDBRequest<PO | undefined>,
			);
			if (po) {
				return this.decode(po);
			}
		});
	}

	async save(obj: CASMetadataObject): Promise<{ didCreate: boolean }> {
		const result = await this.tx(
			"readwrite",
			async ({ store, recordChange }) => {
				const cidStr = obj.cid.toString();
				const existing = await executeIDBRequest(
					store.get(cidStr) as IDBRequest<PO | undefined>,
				);
				const po: PO = this.encode(obj);

				if (existing) {
					po.indexedAt = existing.indexedAt;
					if (po.trashedAt != null && existing.trashedAt != null) {
						po.trashedAt = Math.max(
							po.trashedAt,
							existing.trashedAt,
						);
					}
				}
				recordChange(po, existing);
				await executeIDBRequest(store.put(po));
				return { didCreate: !existing };
			},
		);
		casMetadataSave.dispatch(obj);
		return result;
	}

	async delete(cid: CID): Promise<void> {
		const existing = await this.tx(
			"readwrite",
			async ({ store, recordChange }) => {
				const cidStr = cid.toString();
				const existing = await executeIDBRequest(
					store.get(cidStr) as IDBRequest<PO | undefined>,
				);
				if (!existing) {
					return;
				}
				recordChange(undefined, existing); // 记录删除
				await executeIDBRequest(store.delete(cidStr));
				return existing;
			},
		);
		if (existing) {
			casMetadataDelete.dispatch(this.decode(existing));
		}
	}

	async *find(
		filterBy: CASMetadataObjectFilters,
		after?: string,
	): AsyncIterableIterator<{ node: CASMetadataObject; cursor: string }> {
		const db = await this.db;
		const filter = this.filterBuilder.build(filterBy);
		for await (const edge of iterateIDBObjectStore({
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
		})) {
			if (filter(edge.node)) {
				yield edge;
			}
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
			trashedAt: obj.trashedAt?.getTime(),
		};
	}

	private decode(po: PO): CASMetadataObject {
		return {
			...po,
			cid: CID.parse(po.cid),
			indexedAt: new Date(po.indexedAt),
			trashedAt: po.trashedAt ? new Date(po.trashedAt) : undefined,
		};
	}
}

interface PO {
	cid: string;
	indexedAt: number;
	filename?: string;
	format?: string;
	size?: number;
	trashedAt?: number;
}

interface Stats {
	normalBytes: number;
	trashBytes: number;
}

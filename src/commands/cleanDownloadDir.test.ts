/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import cleanDownloadDir, { enforceDownloadQuota } from "./cleanDownloadDir";
import type { CAS } from "#src/types/CAS";
import type {
	CASMetadata,
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "#src/types/CASMetadata";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const DL = "dl";
const GW = "gw";

async function makeCid(content: string) {
	const hash = await sha256.digest(new TextEncoder().encode(content));
	return CID.create(1, raw.code, hash);
}

interface FakeCopy {
	dir: string;
	mtime: number;
	size: number;
	isTrashed: boolean;
}

/**
 * 磁盘假件：按 CID 记录其各目录的副本，清理只经由目录遍历与删除两个原语访问磁盘。
 * 遍历契约与真实 CAS 一致：只产出目标目录的正常副本（含路径与磁盘 stat），
 * 回收站副本与其它目录的副本不会出现在遍历结果里。
 */
class FakeCas {
	readonly copies = new Map<string, { cid: CID; list: FakeCopy[] }>();
	readonly deleted: string[] = [];

	add(cid: CID, copy: FakeCopy) {
		const key = cid.toString();
		const entry = this.copies.get(key);
		if (entry) {
			entry.list.push(copy);
		} else {
			this.copies.set(key, { cid, list: [copy] });
		}
	}

	async *walkDirCopies(dir: string) {
		for (const { cid, list } of this.copies.values()) {
			for (const copy of list) {
				if (copy.dir !== dir || copy.isTrashed) {
					continue;
				}
				yield {
					cid,
					path: `${dir}/${dir}/${cid.toString()}.data`,
					stat: { mtime: copy.mtime, size: copy.size },
				};
			}
		}
	}

	async removeCopyInDir(cid: CID, dir: string): Promise<boolean> {
		const entry = this.copies.get(cid.toString());
		const index =
			entry?.list.findIndex((c) => c.dir === dir && !c.isTrashed) ?? -1;
		if (!entry || index < 0) {
			return false;
		}
		entry.list.splice(index, 1);
		this.deleted.push(cid.toString());
		return true;
	}

	has(cid: CID, dir: string, isTrashed = false) {
		return (this.copies.get(cid.toString())?.list ?? []).some(
			(c) => c.dir === dir && c.isTrashed === isTrashed,
		);
	}
}

function casOf(disk: FakeCas): CAS {
	return {
		walkDirCopies: (dir: string) => disk.walkDirCopies(dir),
		removeCopyInDir: (cid: CID, dir: string) =>
			disk.removeCopyInDir(cid, dir),
	} as unknown as CAS;
}

class MemMeta implements CASMetadata {
	nodes: CASMetadataObject[] = [];
	dirBytes: Record<string, number> = {};

	async get(cid: CID) {
		return this.nodes.find((i) => i.cid.equals(cid));
	}
	async merge(obj: CASMetadataObject) {
		const index = this.nodes.findIndex((i) => i.cid.equals(obj.cid));
		if (index >= 0) {
			this.nodes[index] = obj;
		} else {
			this.nodes.push(obj);
		}
		return { didCreate: index < 0 };
	}
	async delete(cid: CID) {
		this.nodes = this.nodes.filter((i) => !i.cid.equals(cid));
	}
	async *find({ filterBy }: { filterBy?: CASMetadataObjectFilters } = {}) {
		const query = filterBy?.query;
		for (const node of this.nodes) {
			if (query != null && !(node.filename ?? "").includes(query)) {
				continue;
			}
			yield { node, cursor: node.cid.toString() };
		}
	}
	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0, dirBytes: this.dirBytes };
	}
}

interface Fixture {
	cid: CID;
	node: CASMetadataObject;
}

/**
 * 登记一个只落在 dir 的下载副本，创建时间为 ageDays 天前。
 * 磁盘假件与元数据记录分别建模：清理只读磁盘，二者的差异由用例按需制造。
 */
async function downloaded(
	meta: MemMeta,
	disk: FakeCas,
	content: string,
	dir: string,
	ageDays: number,
	size = 100,
): Promise<Fixture> {
	const cid = await makeCid(content);
	const node: CASMetadataObject = {
		cid,
		indexedAt: new Date(NOW - ageDays * DAY),
		size,
		copies: [{ dir }],
	};
	meta.nodes.push(node);
	disk.add(cid, { dir, mtime: NOW - ageDays * DAY, size, isTrashed: false });
	return { cid, node };
}

/** 只落盘、不进元数据：磁盘上有、元数据无 */
async function unindexed(
	disk: FakeCas,
	content: string,
	dir: string,
	ageDays: number,
	size = 100,
) {
	const cid = await makeCid(content);
	disk.add(cid, { dir, mtime: NOW - ageDays * DAY, size, isTrashed: false });
	return cid;
}

/** 批量落盘 count 个超保留期副本（内容各不相同，各占 size 字节） */
async function expiredCopies(
	meta: MemMeta,
	disk: FakeCas,
	count: number,
	size: number,
) {
	for (let i = 0; i < count; i++) {
		await downloaded(meta, disk, `expired-${i}`, DL, 10, size);
	}
}

function setup() {
	const meta = new MemMeta();
	const disk = new FakeCas();
	const signal = new AbortController().signal;
	return { disk, meta, signal, cas: casOf(disk) };
}

// 保留期判定以 Date.now() 为基准，固定时钟使「恰好到达保留期」等边界可确定复现
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("cleanDownloadDir 清理下载目录中超保留期的副本", () => {
	it("删除超过保留期的副本，保留期内的不动", async () => {
		const { disk, meta, cas, signal } = setup();
		const old = await downloaded(meta, disk, "old", DL, 10);
		const fresh = await downloaded(meta, disk, "fresh", DL, 3);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(result.deleted).toBe(1);
		expect(disk.deleted).toEqual([old.cid.toString()]);
		expect(disk.has(fresh.cid, DL)).toBe(true);
	});

	it("保留期为 0 时删除目录内全部正常副本", async () => {
		const { disk, meta, cas, signal } = setup();
		// 非零年龄：刚落盘的副本其年龄与保留期同为 0，边界上仍算保留期内
		await downloaded(meta, disk, "a", DL, 0.001);
		await downloaded(meta, disk, "b", DL, 10);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 0,
			signal,
		});

		expect(result.deleted).toBe(2);
	});

	it("恰好到达保留期的副本仍在保留期内，不删除", async () => {
		const { disk, meta, cas, signal } = setup();
		const exact = await downloaded(meta, disk, "exact", DL, 7);
		const older = await downloaded(meta, disk, "older", DL, 8);

		await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(disk.deleted).toEqual([older.cid.toString()]);
		expect(disk.has(exact.cid, DL)).toBe(true);
	});

	it("不触碰同目录的回收站副本", async () => {
		const { disk, meta, cas, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);
		disk.add(cid, { dir: DL, mtime: NOW, size: 100, isTrashed: true });

		await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 0,
			signal,
		});

		expect(disk.has(cid, DL, false)).toBe(false);
		expect(disk.has(cid, DL, true)).toBe(true);
	});

	it("只影响目标目录：同一 CID 在其它目录的副本不受影响", async () => {
		const { disk, meta, cas, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);
		disk.add(cid, {
			dir: GW,
			mtime: NOW,
			size: 100,
			isTrashed: false,
		});

		await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(disk.has(cid, DL)).toBe(false);
		expect(disk.has(cid, GW)).toBe(true);
	});

	it("仍被笔记引用的超期副本照常删除", async () => {
		const { disk, meta, cas, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(result.deleted).toBe(1);
		expect(disk.deleted).toEqual([cid.toString()]);
	});

	it("报告实际删除数量与释放空间", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 10, 1000);
		await downloaded(meta, disk, "b", DL, 9, 2500);
		await downloaded(meta, disk, "fresh", DL, 1, 4096);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(result).toEqual({ deleted: 2, freedBytes: 3500 });
	});

	it("释放量取自磁盘 stat：未被元数据收录的副本同样删除并计入", async () => {
		const { disk, meta, cas, signal } = setup();
		const indexed = await downloaded(meta, disk, "indexed", DL, 10, 100);
		const unrecorded = await unindexed(disk, "orphan", DL, 10, 2048);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			signal,
		});

		expect(result).toEqual({ deleted: 2, freedBytes: 2148 });
		expect(disk.has(unrecorded, DL)).toBe(false);
		// 副本状态由后台索引对账：命令层只删文件，不改写任何元数据记录
		expect(await meta.get(unrecorded)).toBeUndefined();
		expect((await meta.get(indexed.cid))?.copies).toEqual([{ dir: DL }]);
	});

	it("进度每删除一个副本回调一次", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 10);
		await downloaded(meta, disk, "b", DL, 9);
		const onProgress = vi.fn();

		await cleanDownloadDir(
			cas,
			{ dirs: [DL], retentionDays: 7, signal },
			onProgress,
		);

		const calls = onProgress.mock.calls as [number, string][];
		// 并发删除下完成顺序不固定，只断言计数连续
		expect([...calls.map(([index]) => index)].sort()).toEqual([1, 2]);
	});

	it("给出 freeBytes 时释放达标即停，释放量不小于目标", async () => {
		const { disk, meta, cas, signal } = setup();
		await expiredCopies(meta, disk, 40, 100);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL],
			retentionDays: 7,
			freeBytes: 500,
			signal,
		});

		expect(result.freedBytes).toBeGreaterThanOrEqual(500);
		// 达标即停：还有副本留在盘上
		expect(result.deleted).toBeLessThan(40);
	});

	it("多目录时跨目录累计释放量", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		await downloaded(meta, disk, "b", GW, 20, 100);
		await downloaded(meta, disk, "c", GW, 10, 100);

		const result = await cleanDownloadDir(cas, {
			dirs: [DL, GW],
			retentionDays: 7,
			signal,
		});

		expect(result).toEqual({ deleted: 3, freedBytes: 300 });
	});

	it("信号已中止时立即抛出，不删除任何副本", async () => {
		const { disk, meta, cas } = setup();
		await downloaded(meta, disk, "a", DL, 10);
		const controller = new AbortController();
		controller.abort();

		await expect(
			cleanDownloadDir(cas, {
				dirs: [DL],
				retentionDays: 7,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(disk.deleted).toEqual([]);
	});
});

describe("enforceDownloadQuota 写入前按配额自动清理", () => {
	function quotaOptions(
		signal: AbortSignal,
		overrides: Partial<Parameters<typeof enforceDownloadQuota>[2]> = {},
	) {
		return {
			targetDir: DL,
			downloadDirs: [DL],
			quotaBytes: 100,
			incomingBytes: 0,
			retentionDays: 7,
			signal,
			...overrides,
		};
	}

	it("未超过配额时不枚举也不清理", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 50);
		meta.dirBytes = { [DL]: 100 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal),
		);

		expect(result).toEqual({
			didClean: false,
			didExceedQuota: false,
			usedBytes: 100,
			freedBytes: 0,
		});
		expect(disk.deleted).toEqual([]);
	});

	it("配额 ≤0 时不触发任何清理", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		meta.dirBytes = { [DL]: 1000 };

		await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal, {
				quotaBytes: 0,
			}),
		);

		expect(disk.deleted).toEqual([]);
	});

	it("写入非下载目录时不触发清理", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		meta.dirBytes = { [DL]: 1000 };

		await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal, {
				targetDir: "primary",
			}),
		);

		expect(disk.deleted).toEqual([]);
	});

	it("超过配额时按超出量清理，释放量不小于缺口", async () => {
		const { disk, meta, cas, signal } = setup();
		await expiredCopies(meta, disk, 20, 100);
		meta.dirBytes = { [DL]: 2000 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal, {
				quotaBytes: 1500,
			}),
		);

		// 缺口 500：并发删除会略微超出，但达标即停
		expect(result.didExceedQuota).toBe(false);
		expect(result.freedBytes).toBeGreaterThanOrEqual(500);
		expect(disk.deleted.length).toBeGreaterThan(0);
		expect(disk.deleted.length).toBeLessThan(20);
	});

	it("清理量含本次写入，新副本落盘后仍落在配额内", async () => {
		const { disk, meta, cas, signal } = setup();
		await expiredCopies(meta, disk, 20, 100);
		meta.dirBytes = { [DL]: 2000 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal, {
				quotaBytes: 1500,
				incomingBytes: 500,
			}),
		);

		// 缺口 1000：既要腾出超额，也要为新副本留出 500
		expect(result.didClean).toBe(true);
		expect(result.didExceedQuota).toBe(false);
		expect(result.usedBytes).toBe(2000);
		expect(result.freedBytes).toBeGreaterThanOrEqual(1000);
	});

	it("全部下载目录合计超配额时同样触发清理", async () => {
		const { disk, meta, cas, signal } = setup();
		const old = await downloaded(meta, disk, "a", GW, 30, 100);
		meta.dirBytes = { [DL]: 90, [GW]: 90 };

		await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal, { downloadDirs: [DL, GW] }),
		);

		expect(disk.deleted).toEqual([old.cid.toString()]);
	});

	it("保留期内的副本已占满配额时放弃清理（写入照常成功）", async () => {
		const { disk, meta, cas, signal } = setup();
		const fresh = await downloaded(meta, disk, "a", DL, 1, 100);
		meta.dirBytes = { [DL]: 300 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(signal),
		);

		expect(result.didClean).toBe(true);
		expect(result.didExceedQuota).toBe(true);
		expect(disk.deleted).toEqual([]);
		expect(disk.has(fresh.cid, DL)).toBe(true);
	});
});

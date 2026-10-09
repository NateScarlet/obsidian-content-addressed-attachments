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
	isTrashed: boolean;
}

/**
 * 磁盘假件：只按「CID × 目录」建模副本，未知命名格式的文件另记在 foreignFiles，
 * 它们没有 CID，命令无从枚举到，清理不应触碰。
 *
 * deleteCopyInDir 按真实契约同步收敛元数据：副本删净且无引用时记录一并删除，
 * 被引用时保留记录并清空副本状态——命令层不得依赖记录仍然存在。
 */
class FakeCas {
	readonly copies = new Map<string, FakeCopy[]>();
	readonly foreignFiles: string[] = [];
	readonly deleted: string[] = [];
	/** 只在副本删净时才做引用判定，记录判定过的 CID */
	readonly referenceChecks: string[] = [];
	referenced = new Set<string>();

	constructor(private meta: MemMeta) {}

	add(cid: CID, copy: FakeCopy) {
		const key = cid.toString();
		this.copies.set(key, [...(this.copies.get(key) ?? []), copy]);
	}

	async *lookup(cid: CID) {
		for (const copy of this.copies.get(cid.toString()) ?? []) {
			yield {
				dir: copy.dir,
				path: `${copy.dir}/${cid.toString()}`,
				stat: { mtime: copy.mtime, size: 0 },
				isTrashed: copy.isTrashed,
			};
		}
	}

	async deleteCopyInDir(
		cid: CID,
		dir: string,
		isReferenced: (cid: CID) => Promise<boolean>,
	): Promise<boolean> {
		const key = cid.toString();
		const copies = this.copies.get(key) ?? [];
		const hasNormalCopy = copies.some((c) => c.dir === dir && !c.isTrashed);
		if (!hasNormalCopy) {
			return false;
		}
		this.copies.set(
			key,
			copies.filter((c) => !(c.dir === dir && !c.isTrashed)),
		);
		this.deleted.push(key);
		const remaining = this.copies.get(key) ?? [];
		const node = await this.meta.get(cid);
		if (remaining.length > 0) {
			await this.meta.merge({
				...(node ?? { cid, indexedAt: new Date() }),
				copies: remaining.map((c) => ({
					dir: c.dir,
					trashedAt: c.isTrashed ? new Date(c.mtime) : undefined,
				})),
			});
			return true;
		}
		this.referenceChecks.push(key);
		if (await isReferenced(cid)) {
			await this.meta.merge({
				...(node ?? { cid, indexedAt: new Date() }),
				copies: [],
			});
		} else {
			await this.meta.delete(cid);
		}
		return true;
	}

	has(cid: CID, dir: string, isTrashed = false) {
		return (this.copies.get(cid.toString()) ?? []).some(
			(c) => c.dir === dir && c.isTrashed === isTrashed,
		);
	}
}

function casOf(disk: FakeCas) {
	return {
		lookup: (cid: CID) => disk.lookup(cid),
		deleteCopyInDir: (
			cid: CID,
			dir: string,
			isReferenced: (cid: CID) => Promise<boolean>,
		) => disk.deleteCopyInDir(cid, dir, isReferenced),
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
		const dirs = new Set(filterBy?.hasCopyInDirs ?? []);
		for (const node of this.nodes) {
			const hit = node.copies?.some(
				(c) => c.trashedAt == null && dirs.has(c.dir),
			);
			if (hit) {
				yield { node, cursor: node.cid.toString() };
			}
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

/** 登记一个只落在 dir 的下载副本，创建时间为 ageDays 天前 */
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
	disk.add(cid, { dir, mtime: NOW - ageDays * DAY, isTrashed: false });
	return { cid, node };
}

function setup() {
	const meta = new MemMeta();
	const disk = new FakeCas(meta);
	const isReferenced = (cid: CID) =>
		Promise.resolve(disk.referenced.has(cid.toString()));
	const signal = new AbortController().signal;
	return { disk, meta, isReferenced, signal, cas: casOf(disk) };
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
		const { disk, meta, cas, isReferenced, signal } = setup();
		const old = await downloaded(meta, disk, "old", DL, 10);
		const fresh = await downloaded(meta, disk, "fresh", DL, 3);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(result.deleted).toBe(1);
		expect(disk.deleted).toEqual([old.cid.toString()]);
		expect(disk.has(fresh.cid, DL)).toBe(true);
	});

	it("保留期为 0 时删除目录内全部正常副本", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		// 非零年龄：刚落盘的副本其年龄与保留期同为 0，边界上仍算保留期内
		await downloaded(meta, disk, "a", DL, 0.001);
		await downloaded(meta, disk, "b", DL, 10);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 0,
			isReferenced,
			signal,
		});

		expect(result.deleted).toBe(2);
	});

	it("恰好到达保留期的副本仍在保留期内，不删除", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const exact = await downloaded(meta, disk, "exact", DL, 7);
		const older = await downloaded(meta, disk, "older", DL, 8);

		await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(disk.deleted).toEqual([older.cid.toString()]);
		expect(disk.has(exact.cid, DL)).toBe(true);
	});

	it("不触碰同目录的回收站副本", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);
		disk.add(cid, { dir: DL, mtime: NOW, isTrashed: true });

		await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 0,
			isReferenced,
			signal,
		});

		expect(disk.has(cid, DL, false)).toBe(false);
		expect(disk.has(cid, DL, true)).toBe(true);
	});

	it("只影响目标目录：同一 CID 在其它目录的副本不受影响", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);
		disk.add(cid, { dir: GW, mtime: NOW, isTrashed: false });

		await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(disk.has(cid, DL)).toBe(false);
		expect(disk.has(cid, GW)).toBe(true);
		expect(disk.referenceChecks).toEqual([]);
	});

	it("仍被笔记引用的超期副本照常删除", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const { cid } = await downloaded(meta, disk, "a", DL, 10);
		disk.referenced.add(cid.toString());

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(result.deleted).toBe(1);
		expect(disk.deleted).toEqual([cid.toString()]);
		// 副本删净才做引用判定，并把判定交回给 CAS 层决定记录去留
		expect(disk.referenceChecks).toEqual([cid.toString()]);
	});

	it("未知命名格式的文件（未收录进元数据）不被清理", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		disk.foreignFiles.push(`${DL}/notes/readme.txt`);
		await downloaded(meta, disk, "a", DL, 10);

		await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(disk.foreignFiles).toEqual([`${DL}/notes/readme.txt`]);
		expect(disk.deleted).toHaveLength(1);
	});

	it("报告实际删除数量与释放空间", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		await downloaded(meta, disk, "a", DL, 10, 1000);
		await downloaded(meta, disk, "b", DL, 9, 2500);
		await downloaded(meta, disk, "fresh", DL, 1, 4096);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(result).toEqual({ deleted: 2, freedBytes: 3500 });
	});

	it("副本删净且无引用、元数据记录随之删除时仍计入释放量", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const only = await downloaded(meta, disk, "a", DL, 10, 2048);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			isReferenced,
			signal,
		});

		expect(result).toEqual({ deleted: 1, freedBytes: 2048 });
		expect(await meta.get(only.cid)).toBeUndefined();
	});

	it("进度每删除一个副本回调一次", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		await downloaded(meta, disk, "a", DL, 10);
		await downloaded(meta, disk, "b", DL, 9);
		const onProgress = vi.fn();

		await cleanDownloadDir(
			cas,
			meta,
			{ dirs: [DL], retentionDays: 7, isReferenced, signal },
			onProgress,
		);

		const calls = onProgress.mock.calls as [number, string][];
		expect(calls.map(([index]) => index)).toEqual([1, 2]);
	});

	it("给出 freeBytes 时按创建时间从最旧开始删，达标即停", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		const newest = await downloaded(meta, disk, "c", DL, 8, 100);
		const oldest = await downloaded(meta, disk, "a", DL, 30, 100);
		const middle = await downloaded(meta, disk, "b", DL, 20, 100);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL],
			retentionDays: 7,
			freeBytes: 100,
			isReferenced,
			signal,
		});

		expect(result).toEqual({ deleted: 1, freedBytes: 100 });
		expect(disk.deleted).toEqual([oldest.cid.toString()]);
		expect(disk.has(middle.cid, DL)).toBe(true);
		expect(disk.has(newest.cid, DL)).toBe(true);
	});

	it("多目录时跨目录累计释放量达标即停", async () => {
		const { disk, meta, cas, isReferenced, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		await downloaded(meta, disk, "b", GW, 20, 100);
		await downloaded(meta, disk, "c", GW, 10, 100);

		const result = await cleanDownloadDir(cas, meta, {
			dirs: [DL, GW],
			retentionDays: 7,
			freeBytes: 150,
			isReferenced,
			signal,
		});

		expect(result).toEqual({ deleted: 2, freedBytes: 200 });
		expect(disk.has(await makeCid("c"), GW)).toBe(true);
	});

	it("信号已中止时立即抛出，不删除任何副本", async () => {
		const { disk, meta, cas, isReferenced } = setup();
		await downloaded(meta, disk, "a", DL, 10);
		const controller = new AbortController();
		controller.abort();

		await expect(
			cleanDownloadDir(cas, meta, {
				dirs: [DL],
				retentionDays: 7,
				isReferenced,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(disk.deleted).toEqual([]);
	});
});

describe("enforceDownloadQuota 写入前按配额自动清理", () => {
	function quotaOptions(
		disk: FakeCas,
		signal: AbortSignal,
		overrides: Partial<Parameters<typeof enforceDownloadQuota>[2]> = {},
	) {
		return {
			targetDir: DL,
			downloadDirs: [DL],
			quotaBytes: 100,
			incomingBytes: 0,
			retentionDays: 7,
			isReferenced: (cid: CID) =>
				Promise.resolve(disk.referenced.has(cid.toString())),
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
			quotaOptions(disk, signal),
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
			quotaOptions(disk, signal, { quotaBytes: 0 }),
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
			quotaOptions(disk, signal, { targetDir: "primary" }),
		);

		expect(disk.deleted).toEqual([]);
	});

	it("超过配额时按超出量清理到达标", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		await downloaded(meta, disk, "b", DL, 20, 100);
		await downloaded(meta, disk, "c", DL, 10, 100);
		meta.dirBytes = { [DL]: 300 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(disk, signal),
		);

		// 超出 200：删两个最旧副本后达标
		expect(result.didExceedQuota).toBe(false);
		expect(disk.deleted).toHaveLength(2);
		expect(disk.has(await makeCid("c"), DL)).toBe(true);
	});

	it("清理量含本次写入，新副本落盘后仍落在配额内", async () => {
		const { disk, meta, cas, signal } = setup();
		await downloaded(meta, disk, "a", DL, 30, 100);
		await downloaded(meta, disk, "b", DL, 20, 100);
		meta.dirBytes = { [DL]: 150 };

		const result = await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(disk, signal, { incomingBytes: 100 }),
		);

		// 缺口 150：既要腾出超额 50，也要为新副本留出 100
		expect(result).toEqual({
			didClean: true,
			didExceedQuota: false,
			usedBytes: 150,
			freedBytes: 200,
		});
	});

	it("全部下载目录合计超配额时同样触发清理", async () => {
		const { disk, meta, cas, signal } = setup();
		const old = await downloaded(meta, disk, "a", GW, 30, 100);
		meta.dirBytes = { [DL]: 90, [GW]: 90 };

		await enforceDownloadQuota(
			cas,
			meta,
			quotaOptions(disk, signal, { downloadDirs: [DL, GW] }),
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
			quotaOptions(disk, signal),
		);

		expect(result.didClean).toBe(true);
		expect(result.didExceedQuota).toBe(true);
		expect(disk.deleted).toEqual([]);
		expect(disk.has(fresh.cid, DL)).toBe(true);
	});
});

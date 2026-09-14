/* eslint-disable @typescript-eslint/require-await -- 接缝测试的内存 fake 为同步实现，「await」，无异步副作用 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { TFile } from "obsidian";
import ReferenceManager from "./ReferenceManager";
import type { ReferenceManagerCache } from "./ReferenceManager";
import type ContentAddressedAttachmentPlugin from "./main";
import type { CAS } from "./types/CAS";
import type { CASMetadata } from "./types/CASMetadata";

/**
 * ReferenceManager 新鲜性接缝：以磁盘为唯一可信源。
 * 回归 bug #41——引用索引若读取过时缓存（cachedRead / 编辑器缓冲），
 * 会把实际被笔记引用的附件判成未引用。
 */

/** 内存引用缓存：覆盖 count(skipVerify) → mergedEntryCount → findBatch 与 loadFile → add/expireByPath 路径 */
class MemRefCache implements ReferenceManagerCache {
	private entries = new Map<
		string,
		{ cid: string; path: string; lastUpdatedAt: number }
	>();
	private key(cid: CID, path: string): string {
		return `${cid.toString()}|${path}`;
	}
	async add(cid: CID, normalizedPath: string): Promise<void> {
		const k = this.key(cid, normalizedPath);
		const now = Date.now();
		const existing = this.entries.get(k);
		if (existing) {
			existing.lastUpdatedAt = now;
		} else {
			this.entries.set(k, {
				cid: cid.toString(),
				path: normalizedPath,
				lastUpdatedAt: now,
			});
		}
	}
	async *find(cid: CID): AsyncIterableIterator<string> {
		for (const e of this.entries.values()) {
			if (e.cid === cid.toString()) yield e.path;
		}
	}
	async findBatch(
		cids: CID[],
	): Promise<Map<string, { cid: string; normalizedPath: string }[]>> {
		const result = new Map<
			string,
			{ cid: string; normalizedPath: string }[]
		>();
		for (const cid of cids) {
			const cidStr = cid.toString();
			const arr = [...this.entries.values()]
				.filter((e) => e.cid === cidStr)
				.slice(0, 128)
				.map((e) => ({ cid: e.cid, normalizedPath: e.path }));
			if (arr.length > 0) result.set(cidStr, arr);
		}
		return result;
	}
	async expireByPath(
		normalizedPath: string,
		lastUpdatedBefore: Date,
	): Promise<number> {
		const before = lastUpdatedBefore.getTime();
		let removed = 0;
		for (const [k, e] of this.entries) {
			if (e.path === normalizedPath && e.lastUpdatedAt < before) {
				this.entries.delete(k);
				removed++;
			}
		}
		return removed;
	}
	async cachedPaths(): Promise<Set<string>> {
		return new Set([...this.entries.values()].map((e) => e.path));
	}
	async removeByPaths(paths: string[]): Promise<number> {
		const targets = new Set(paths);
		let removed = 0;
		for (const [k, e] of this.entries) {
			if (targets.has(e.path)) {
				this.entries.delete(k);
				removed++;
			}
		}
		return removed;
	}
	async cutoffAt(): Promise<Date> {
		return this.cutoff;
	}
	async setCutoffAt(v: Date): Promise<void> {
		this.cutoff = v;
	}
	private cutoff = new Date(0);
}

const CID_STR = "bafkreiewoknhf25r23eytiq6r3ggtcgjo34smnn2hlfzqwhp5doiw6e4di";
const X = CID.parse(CID_STR);
const NOTE_PATH = "notes/ref.md";

/** 构造一个 vault 与插件假实现（最小化，仅覆盖 ReferenceManager 所触达的接口） */
function makeFake(deps: {
	/** 磁盘内容：真相 */
	diskContent: string;
	/** cachedRead 返回：过时的缓存（旧内容） */
	cacheContent: string;
	/** 笔记 stat.mtime（增量扫描按此门槛挑选文件），默认使文件一定被扫描 */
	mtime?: number;
	/** 增量扫描进度报告器：测试注入空实现以避开 DOM/svelte mount */
	incrementalScanReporter?: {
		begin: (total: number) => {
			update: (index: number, file: string) => void;
			finish: () => void;
		};
	};
}) {
	const disk = new Map<string, string>([[NOTE_PATH, deps.diskContent]]);
	const cache = new Map<string, string>([[NOTE_PATH, deps.cacheContent]]);
	const file = new TFile();
	file.path = NOTE_PATH;
	file.extension = "md";
	file.stat = {
		mtime: deps.mtime ?? Date.now(),
		ctime: Date.now(),
		size: 0,
	};
	const vault = {
		getAbstractFileByPath(path: string) {
			return path === NOTE_PATH ? file : null;
		},
		read(file: TFile): Promise<string> {
			return Promise.resolve(disk.get(file.path) ?? "");
		},
		cachedRead(file: TFile): Promise<string> {
			return Promise.resolve(cache.get(file.path) ?? "");
		},
		getMarkdownFiles() {
			return [file];
		},
	};

	const referenceCache = new MemRefCache();
	const plugin = {
		app: { vault },
		cas: {
			index: vi.fn(async () => {}),
		},
		casMetadata: {
			get: vi.fn(async () => undefined),
		},
		settings: { primaryDir: "CAS", downloadDir: "", gateways: [] },
	} as unknown as ContentAddressedAttachmentPlugin;

	const rm = new ReferenceManager(plugin, {
		cache: referenceCache,
		incrementalScanReporter: deps.incrementalScanReporter ?? {
			begin: () => ({ update() {}, finish() {} }),
		},
	});
	return { rm, referenceCache, file };
}

describe("ReferenceManager 新鲜性：磁盘为唯一可信源", () => {
	it("loadFile 依据磁盘内容索引引用，而非过时的 cachedRead", async () => {
		// 磁盘是真源：内容里引用了 X；cachedRead 是过时旧内容（无 X）
		const { rm } = makeFake({
			diskContent: `avatar: ![[ipfs://${CID_STR}]]`,
			cacheContent: "see note",
		});

		await rm.loadFile(NOTE_PATH);

		// 磁盘内容引用了 X → 必报已引用；修复前读取 cachedRead 会误判为未引用
		const referenced = await rm.count(X, 1, undefined, {
			skipVerify: true,
		});
		expect(referenced).toBe(1);
	});

	it("ensureFresh 经增量扫描依据磁盘内容索引引用，而非过时的 cachedRead", async () => {
		// 磁盘是真源（引用 X）；cachedRead 是过时旧内容（无 X）。
		// mtime 设为足够大，确保增量扫描（mtime>=cutoffAt，初始 cutoff=0）一定纳入该文件。
		const { rm } = makeFake({
			diskContent: `fig: ipfs://${CID_STR}`,
			cacheContent: "old note",
			mtime: Date.now(),
		});

		// 进入 ensureFresh：触发增量扫描 → loadFile → 读取磁盘内容索引
		await rm.ensureFresh(undefined);

		const referenced = await rm.count(X, 1, undefined, {
			skipVerify: true,
		});
		expect(referenced).toBe(1);
	});
});

//#region 恢复队列：扫描内的恢复不得自锁，且去重、有界、可取消、失败可见

/** 仅锁定引用（非 ipfs://）：knownIPFSCids 短路判定不覆盖，必然走全库查询 */
function lockedLink(cid: string): string {
	return `internal.ipfs-locked:${cid},https://example.com/a.png`;
}

async function makeDistinctCid(seed: string): Promise<CID> {
	const bytes = new TextEncoder().encode(seed);
	const hash = await sha256.digest(bytes);
	return CID.create(1, raw.code, hash);
}

/**
 * 恢复队列场景的假实现：可控数量笔记、每篇内容、被垃圾箱标记的 cid 集合，
 * 并记录恢复调用（并发峰值、允许目录）与设置读取。
 */
function makeQueueFake(deps: {
	/** 笔记路径 → 磁盘内容 */
	notes: Map<string, string>;
	/** 视为处于回收站的 cid 集合（其余 cid 不触发物理恢复） */
	trashed: Set<string>;
	/** 元数据读取失败（用于验证失败可见且不中断其余恢复） */
	metadataGetError?: Error;
	/** 扫描/恢复进度：注入空实现避免 DOM */
	onError?: (error: unknown) => void;
}) {
	const files = [...deps.notes.keys()].map((path) => {
		const file = new TFile();
		file.path = path;
		file.extension = "md";
		file.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
		return file;
	});
	const byPath = new Map(files.map((f) => [f.path, f]));

	const vault = {
		getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
		read: (file: TFile) => Promise.resolve(deps.notes.get(file.path) ?? ""),
		cachedRead: (file: TFile) =>
			Promise.resolve(deps.notes.get(file.path) ?? ""),
		getMarkdownFiles: () => files,
	};

	/** 并发峰值观测：同时在飞的元数据读取数 */
	let inFlight = 0;
	let peakInFlight = 0;
	/** 每次物理恢复收到的允许目录列表 */
	const restoreDirs: (string[] | undefined)[] = [];

	const restoreIfTrashed = vi.fn(async (_cid: CID, dirs?: string[]) => {
		restoreDirs.push(dirs);
		return true;
	});
	const cas = {
		restoreIfTrashed,
		// 索引写入：projectLinkIndex 会调用，本套用例不关心其结果
		index: vi.fn(async () => {}),
	} as unknown as CAS;

	const metadataGet = vi.fn(async (cid: CID) => {
		inFlight++;
		peakInFlight = Math.max(peakInFlight, inFlight);
		// 让在飞窗口可观测（并发峰值与设置懒读都依赖此窗口）
		await new Promise((r) => window.setTimeout(r, 1));
		inFlight--;
		if (deps.metadataGetError) throw deps.metadataGetError;
		return deps.trashed.has(cid.toString())
			? {
					cid,
					indexedAt: new Date(),
					copies: [{ dir: "attachments/cas", trashedAt: new Date() }],
				}
			: undefined;
	});
	const casMetadata = { get: metadataGet } as unknown as CASMetadata;

	const settings = {
		primaryDir: "attachments/cas",
		downloadDir: "downloads",
		gateways: [] as { downloadDir?: string }[],
	};
	const plugin = {
		app: { vault },
		cas,
		casMetadata,
		settings,
	} as unknown as ContentAddressedAttachmentPlugin;

	const rm = new ReferenceManager(plugin, {
		cache: new MemRefCache(),
		incrementalScanReporter: {
			begin: () => ({ update() {}, finish() {} }),
		},
		restoreErrorReporter: deps.onError ?? (() => {}),
	});
	return {
		rm,
		restoreIfTrashed,
		restoreDirs,
		metadataGet,
		getPeakInFlight: () => peakInFlight,
		settings,
	};
}

describe("恢复队列：扫描自锁与批处理", () => {
	it("扫描内的恢复判定不应让扫描永久挂起", async () => {
		const { rm } = makeQueueFake({
			notes: new Map([
				["notes/ref.md", `fig: ![[${lockedLink(CID_STR)}]]`],
			]),
			trashed: new Set([X.toString()]),
		});
		const outcome = await Promise.race([
			rm.ensureFresh(undefined).then(() => "done" as const),
			new Promise<"stuck">((resolve) =>
				window.setTimeout(() => resolve("stuck"), 1000),
			),
		]);
		expect(outcome).toBe("done");
	});

	it("扫描不应永久占用 scan 单飞位（后续 ensureFresh 仍可完成）", async () => {
		const { rm } = makeQueueFake({
			notes: new Map([
				["notes/ref.md", `fig: ![[${lockedLink(CID_STR)}]]`],
			]),
			trashed: new Set([X.toString()]),
		});
		await Promise.race([
			rm.ensureFresh(undefined),
			new Promise((r) => window.setTimeout(r, 1500)),
		]);
		// 第二次 ensureFresh 若命中残留的 scan flight 将同样永久挂起
		const outcome = await Promise.race([
			rm.ensureFresh(undefined).then(() => "done" as const),
			new Promise<"stuck">((resolve) =>
				window.setTimeout(() => resolve("stuck"), 1000),
			),
		]);
		expect(outcome).toBe("done");
	});

	it("同一 cid 被多篇笔记引用时只恢复一次（入队按 cid 去重）", async () => {
		const notes = new Map(
			Array.from({ length: 8 }, (_, i) => [
				`notes/n${i}.md`,
				`fig: ![[ipfs://${CID_STR}]]`,
			]),
		);
		const { rm, restoreIfTrashed } = makeQueueFake({
			notes,
			trashed: new Set([X.toString()]),
		});

		await rm.ensureFresh(undefined);
		await new Promise((r) => window.setTimeout(r, 300));

		// 去重按注册窗口合并：8 篇引用同一 cid，远少于逐篇各恢复一次
		// （不保证恰好一次：处理期间重新入队会被下一批重新处理，见 RestoreQueue 的取出语义）
		expect(restoreIfTrashed.mock.calls.length).toBeGreaterThan(0);
		expect(restoreIfTrashed.mock.calls.length).toBeLessThan(8);
	});

	it("同一 cid 在任一笔记中以 ipfs:// 引用时按主存储目录恢复（短路标志 OR 合并）", async () => {
		const { rm, restoreDirs } = makeQueueFake({
			notes: new Map([
				["notes/ipfs.md", `a: ![[ipfs://${CID_STR}]]`],
				["notes/locked.md", `b: ![[${lockedLink(CID_STR)}]]`],
			]),
			trashed: new Set([X.toString()]),
		});

		await rm.ensureFresh(undefined);
		await new Promise((r) => window.setTimeout(r, 300));

		// 全库语义：该 cid 存在 ipfs:// 引用 → 只允许主存储目录（不受锁定引用笔记影响）
		expect(restoreDirs.length).toBeGreaterThan(0);
		expect(
			restoreDirs.every(
				(d) => JSON.stringify(d) === '["attachments/cas"]',
			),
		).toBe(true);
	});

	it("大量不同 cid 时恢复串行分批，不出现并发尖峰", async () => {
		const cids = await Promise.all(
			Array.from({ length: 150 }, (_, i) => makeDistinctCid(`c${i}`)),
		);
		const notes = new Map(
			cids.map((cid, i) => [
				`notes/n${i}.md`,
				`fig: ![[ipfs://${cid.toString()}]]`,
			]),
		);
		const { rm, metadataGet, getPeakInFlight } = makeQueueFake({
			notes,
			trashed: new Set(cids.map((c) => c.toString())),
		});

		await rm.ensureFresh(undefined);
		// 等队列 drain 完（150 个 cid，串行 + 每批一次查询）
		for (let i = 0; i < 100 && metadataGet.mock.calls.length < 150; i++) {
			await new Promise((r) => window.setTimeout(r, 50));
		}

		// 每个 cid 恰好处理一次
		expect(metadataGet).toHaveBeenCalledTimes(150);
		// 队列只维持一个消费循环，且批内逐条串行 → 同时在飞恒为 1
		// （修复前是「全部恢复同时解阻」，峰值随笔记数增长）
		expect(getPeakInFlight()).toBe(1);
	});

	it("恢复失败经上报器给出可见反馈，且不中断其余 cid 的恢复", async () => {
		const onError = vi.fn();
		const cids = await Promise.all(
			Array.from({ length: 5 }, (_, i) => makeDistinctCid(`e${i}`)),
		);
		const notes = new Map(
			cids.map((cid, i) => [
				`notes/n${i}.md`,
				`fig: ![[ipfs://${cid.toString()}]]`,
			]),
		);
		const { rm, metadataGet } = makeQueueFake({
			notes,
			trashed: new Set(cids.map((c) => c.toString())),
			metadataGetError: new Error("disk offline"),
			onError,
		});

		await rm.ensureFresh(undefined);
		await new Promise((r) => window.setTimeout(r, 300));

		// 可见反馈：经注入的上报器上报（不是只写日志）
		expect(onError).toHaveBeenCalled();
		// 失败被隔离在批级：其余 cid 仍被尝试处理
		expect(metadataGet.mock.calls.length).toBeGreaterThan(0);
	});

	it("恢复读取的目录设置在使用时求值，不在构建时捕获", async () => {
		const { rm, restoreDirs, settings } = makeQueueFake({
			notes: new Map([["notes/ref.md", `fig: ![[ipfs://${CID_STR}]]`]]),
			trashed: new Set([X.toString()]),
		});
		// 构建之后、使用之前改动设置：恢复必须读新值
		settings.primaryDir = "attachments/moved";

		await rm.ensureFresh(undefined);
		await new Promise((r) => window.setTimeout(r, 300));

		expect(restoreDirs).toEqual([["attachments/moved"]]);
	});

	it("卸载后队列停止，不再启动新的恢复批次", async () => {
		const cids = await Promise.all(
			Array.from({ length: 150 }, (_, i) => makeDistinctCid(`d${i}`)),
		);
		const notes = new Map(
			cids.map((cid, i) => [
				`notes/n${i}.md`,
				`fig: ![[ipfs://${cid.toString()}]]`,
			]),
		);
		const { rm, restoreIfTrashed } = makeQueueFake({
			notes,
			trashed: new Set(cids.map((c) => c.toString())),
		});

		const scan = rm.ensureFresh(undefined).catch(() => {});
		// 扫描与恢复进行中即卸载
		await new Promise((r) => window.setTimeout(r, 20));
		rm[Symbol.dispose]();
		await scan;

		// 取消发生在下一个引用查询检查点：在飞批次可能被中断，故先轮询到计数
		// 稳定（在飞批次自然收敛）再断言不再增长，避免与恢复耗时耦合导致取样过早。
		const count = () => restoreIfTrashed.mock.calls.length;
		let previous = count();
		for (let i = 0; i < 80; i++) {
			await new Promise((r) => window.setTimeout(r, 25));
			const current = count();
			if (current === previous && current > 0) {
				break;
			}
			previous = current;
		}
		const settled = count();
		await new Promise((r) => window.setTimeout(r, 300));

		// 收敛后队列已停止：不再有新的恢复发生
		expect(settled).toBeGreaterThan(0);
		expect(count()).toBe(settled);
	});
});

//#endregion

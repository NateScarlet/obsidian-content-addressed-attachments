/* eslint-disable @typescript-eslint/require-await -- 接缝测试的内存 fake 为同步实现，「await」，无异步副作用 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { TFile } from "obsidian";
import ReferenceManager from "./ReferenceManager";
import type { ReferenceManagerCache } from "./ReferenceManager";
import type ContentAddressedAttachmentPlugin from "./main";

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

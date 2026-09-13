/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import type { App } from "obsidian";
import { CASImpl } from "./CASImpl";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

/** 内存文件系统：模拟 vault adapter 的磁盘操作 */
class MemFS {
	files = new Map<
		string,
		{ size: number; mtime: number; content?: Uint8Array }
	>();

	write(path: string, content?: Uint8Array, size = 8) {
		this.files.set(path, {
			size: content?.length ?? size,
			mtime: 1_700_000_000_000 + this.files.size,
			content,
		});
	}

	exists(path: string) {
		return this.files.has(path) || this.isDir(path);
	}

	/** 目录是隐式条目：任何文件路径的中间段都算存在的目录 */
	private isDir(path: string) {
		const prefix = path === "" ? "" : `${path}/`;
		for (const p of this.files.keys()) {
			if (p.startsWith(prefix) && p.length > prefix.length) {
				return true;
			}
		}
		return false;
	}

	async stat(path: string) {
		const f = this.files.get(path);
		return f
			? { type: "file" as const, size: f.size, mtime: f.mtime }
			: null;
	}

	async list(path: string) {
		const folders = new Set<string>();
		const files: string[] = [];
		const prefix = path === "" ? "" : `${path}/`;
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			if (rest.includes("/")) {
				folders.add(prefix + rest.split("/")[0]);
			} else {
				files.push(p);
			}
		}
		return { folders: [...folders], files };
	}

	async remove(path: string) {
		this.files.delete(path);
	}

	async rename(src: string, dst: string) {
		const f = this.files.get(src);
		if (!f) {
			throw new Error("Source file does not exist!");
		}
		if (this.files.has(dst)) {
			throw new Error("Destination file already exists!");
		}
		this.files.delete(src);
		this.files.set(dst, f);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const f = this.files.get(path);
		return f?.content
			? f.content.slice().buffer
			: new Uint8Array([1, 2, 3]).buffer;
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, {
			size: data.byteLength,
			mtime: Date.now(),
			content: new Uint8Array(data),
		});
	}
}

/** 内存元数据：模拟 CASMetadata 实现 */
class MemMeta implements CASMetadata {
	map = new Map<string, CASMetadataObject>();

	async get(cid: CID) {
		return this.map.get(cid.toString());
	}

	async merge(obj: CASMetadataObject) {
		const key = obj.cid.toString();
		const didCreate = !this.map.has(key);
		this.map.set(key, obj);
		return { didCreate };
	}

	async mergeBatch(objs: CASMetadataObject[], signal: AbortSignal) {
		signal.throwIfAborted();
		let didCreate = 0;
		for (const obj of objs) {
			const created = await this.merge(obj);
			if (created.didCreate) didCreate++;
		}
		return { didCreate, didChange: objs.length };
	}

	async delete(cid: CID) {
		this.map.delete(cid.toString());
	}

	async *find({
		filterBy,
	}: {
		signal: AbortSignal | undefined;
		filterBy?: {
			cid?: CID[];
			query?: string;
			hasReference?: boolean;
			isTrashed?: boolean;
		};
		after?: string;
	}) {
		for (const obj of this.map.values()) {
			let ok = true;
			if (filterBy?.isTrashed != null) {
				const trashed =
					obj.copies?.some((c) => c.trashedAt != null) ?? false;
				if (trashed !== filterBy.isTrashed) ok = false;
			}
			if (ok) yield { node: obj, cursor: obj.cid.toString() };
		}
	}

	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0 };
	}
}

function setup(dirs: string[]) {
	const fs = new MemFS();
	const adapter = {
		stat: (p: string) => fs.stat(p),
		list: (p: string) => fs.list(p),
		exists: (p: string) => fs.exists(p),
		remove: (p: string) => fs.remove(p),
		rename: (s: string, d: string) => fs.rename(s, d),
		readBinary: (p: string) => fs.readBinary(p),
		writeBinary: (p: string, d: ArrayBuffer) => fs.writeBinary(p, d),
	};
	const vault = {
		adapter,
		getFolderByPath: () => null,
		createFolder: async () => {},
	};
	const app = { vault };
	const meta = new MemMeta();
	const cas = new CASImpl(app as unknown as App, meta, () => dirs);
	return { cas, meta, fs };
}

async function makeObject(content: string) {
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256.digest(bytes);
	const cid = CID.create(1, raw.code, hash);
	return { cid, bytes };
}

/** 收集 objects() 中某 CID 的全部产出（按契约应当只有一条） */
async function objectsFor(cas: CASImpl, cid: CID) {
	const seen: CASMetadataObject[] = [];
	for await (const obj of cas.objects()) {
		if (obj.cid.equals(cid)) {
			seen.push(obj);
		}
	}
	return seen;
}

describe("CASImpl.objects 流式产出", () => {
	/** 分片目录名：相对路径首段 */
	function shardOf(cas: CASImpl, cid: CID) {
		return cas.formatRelPath(cid).split("/")[0];
	}

	/** 找到两个落在不同分片目录的 CID，用于构造「先扫完的分片先产出」场景 */
	async function makeTwoShards(cas: CASImpl) {
		const first = await makeObject("shard-a");
		let second = await makeObject("shard-b");
		for (let i = 0; i < 1000; i++) {
			if (shardOf(cas, first.cid) !== shardOf(cas, second.cid)) {
				return { first, second };
			}
			second = await makeObject(`shard-b-${i}`);
		}
		throw new Error("未能找到两个不同分片的 CID");
	}

	it("后续分片未扫完时，先扫到的分片已能产出对象", async () => {
		const { cas, fs } = setup(["dirA"]);
		const { first, second } = await makeTwoShards(cas);
		// 先写入 first：分片按首次出现顺序遍历，first 所在分片先被扫描
		fs.write(`dirA/${cas.formatRelPath(first.cid)}`);
		fs.write(`dirA/${cas.formatRelPath(second.cid)}`);

		// 阻塞后一个分片的列举：若实现先聚合完再产出，则首个产出永远等不到
		let releaseSecond!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const blockedShard = `dirA/${shardOf(cas, second.cid)}`;
		const list = fs.list.bind(fs);
		fs.list = async (path: string) => {
			if (path === blockedShard) {
				await gate;
			}
			return list(path);
		};

		const iter = cas.objects();
		const produced: CASMetadataObject[] = [];
		const collectFirst = (async () => {
			for await (const obj of iter) {
				produced.push(obj);
				if (obj.cid.equals(first.cid)) {
					return;
				}
			}
		})();

		try {
			await Promise.race([
				collectFirst,
				new Promise<never>((_, reject) =>
					window.setTimeout(
						() =>
							reject(
								new Error(
									"objects() 在后续分片被阻塞时未产出先扫到的对象",
								),
							),
						2000,
					),
				),
			]);
		} finally {
			releaseSecond();
		}

		expect(produced.map((o) => o.cid.toString())).toContain(
			first.cid.toString(),
		);
		await iter.return?.(undefined);
	});

	it("同一 CID 跨目录存在副本时，产出单条记录且包含全部副本实例", async () => {
		const { cas, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirA 正常副本；dirB 回收站副本；dirC 不在 dirs 内，不应被扫到
		fs.write(`dirA/${relPath}`);
		fs.write(`dirB/.trash/${relPath}`);
		fs.write(`dirC/${relPath}`);

		const seen = await objectsFor(cas, cid);

		// 每个 CID 只产出一条记录，且副本实例齐全
		expect(seen).toHaveLength(1);
		const copies = seen[0].copies ?? [];
		expect(copies).toHaveLength(2);
		expect(copies.find((c) => c.dir === "dirA")?.trashedAt).toBeUndefined();
		expect(copies.find((c) => c.dir === "dirB")?.trashedAt).toBeInstanceOf(
			Date,
		);
		expect(copies.find((c) => c.dir === "dirC")).toBeUndefined();
	});

	it("已扫描过的目录不再被回查（在回收站中首见的 CID 不回查本目录正常区）", async () => {
		const { cas, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("trashed-only");
		const relPath = cas.formatRelPath(cid);
		// 只在 dirA 的回收站存在：它会在 dirA 回收站阶段首见
		fs.write(`dirA/.trash/${relPath}`);

		const statPaths: string[] = [];
		const stat = fs.stat.bind(fs);
		fs.stat = async (path: string) => {
			statPaths.push(path);
			return stat(path);
		};

		const seen = await objectsFor(cas, cid);

		expect(seen).toHaveLength(1);
		// 在 dirA 回收站首见时，dirA 的正常路径已扫完，不应再被探测
		expect(statPaths).not.toContain(`dirA/${relPath}`);
		// dirB 尚未扫描，需要探测
		expect(statPaths).toContain(`dirB/${relPath}`);
	});

	it("正常区首见的 CID 不重复探测本目录正常路径", async () => {
		const { cas, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("normal-first");
		const relPath = cas.formatRelPath(cid);
		// dirA 正常副本（在 dirA 正常区首见）；dirB 也有正常副本（后续目录）
		fs.write(`dirA/${relPath}`);
		fs.write(`dirB/${relPath}`);
		// 让 dirA 的回收站存在，否则该路径会被「回收站不存在」短路跳过
		const other = await makeObject("other-trash");
		fs.write(`dirA/.trash/${cas.formatRelPath(other.cid)}`);

		const statPaths: string[] = [];
		const stat = fs.stat.bind(fs);
		fs.stat = async (path: string) => {
			statPaths.push(path);
			return stat(path);
		};

		const seen = await objectsFor(cas, cid);

		expect(seen).toHaveLength(1);
		const countOf = (p: string) => statPaths.filter((i) => i === p).length;
		// 本目录正常路径只由列举阶段的 metadataFromPath 探测一次，
		// 补齐阶段不再重复探测它
		expect(countOf(`dirA/${relPath}`)).toBe(1);
		// 本目录回收站与后续目录都要补齐
		expect(statPaths).toContain(`dirA/.trash/${relPath}`);
		expect(statPaths).toContain(`dirB/${relPath}`);
	});

	it("产出记录带磁盘 size，用于补齐仅有引用而无保存记录的元数据", async () => {
		const { cas, fs } = setup(["dirA"]);
		const { cid } = await makeObject("sized");
		fs.write(`dirA/${cas.formatRelPath(cid)}`, undefined, 1234);

		const seen = await objectsFor(cas, cid);

		expect(seen).toHaveLength(1);
		expect(seen[0].size).toBe(1234);
	});

	it("在回收站首见的 CID，会补齐后续目录的正常副本且只产出一条", async () => {
		const { cas, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("trash-first");
		const relPath = cas.formatRelPath(cid);
		// dirA 只有回收站副本（在 dirA 回收站阶段首见）；dirB 有正常副本（后续目录）
		fs.write(`dirA/.trash/${relPath}`);
		fs.write(`dirB/${relPath}`);

		const seen = await objectsFor(cas, cid);

		expect(seen).toHaveLength(1);
		const copies = seen[0].copies ?? [];
		expect(copies.find((c) => c.dir === "dirA")?.trashedAt).toBeInstanceOf(
			Date,
		);
		expect(copies.find((c) => c.dir === "dirB")?.trashedAt).toBeUndefined();
	});
});

describe("CASImpl 多目录回收站状态（copies）", () => {
	it("index 首次登记时记录多目录副本状态（含回收站副本）", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/${relPath}`);
		fs.write(`dirB/.trash/${relPath}`);

		await cas.index({ cid, indexedAt: new Date() });

		const obj = await meta.get(cid);
		expect(obj?.copies).toHaveLength(2);
		expect(
			obj?.copies?.find((c) => c.dir === "dirB")?.trashedAt,
		).toBeInstanceOf(Date);
		expect(
			obj?.copies?.find((c) => c.dir === "dirA")?.trashedAt,
		).toBeUndefined();
	});

	it("index 后续调用不清空已有回收站状态（回归：多目录下被正常副本覆盖）", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirA 有正常副本，dirB 在回收站
		fs.write(`dirA/${relPath}`);
		fs.write(`dirB/.trash/${relPath}`);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirB", trashedAt: new Date() }],
		});

		await cas.index({ cid, indexedAt: new Date() });

		const obj = await meta.get(cid);
		// dirB 回收站状态保留，不被 dirA 正常副本覆盖
		expect(
			obj?.copies?.find((c) => c.dir === "dirB")?.trashedAt,
		).toBeInstanceOf(Date);
	});

	it("save 新增正常副本时保留其他目录回收站状态", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirB 已在回收站
		fs.write(`dirB/.trash/${relPath}`);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirB", trashedAt: new Date() }],
		});

		const file = new File([bytes], "a.png", { type: "image/png" });
		await cas.save("dirA", file);

		const obj = await meta.get(cid);
		expect(
			obj?.copies?.find((c) => c.dir === "dirA")?.trashedAt,
		).toBeUndefined();
		expect(
			obj?.copies?.find((c) => c.dir === "dirB")?.trashedAt,
		).toBeInstanceOf(Date);
	});

	it("trash 把所有目录副本移入回收站并更新 copies", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/${relPath}`, bytes);
		fs.write(`dirB/${relPath}`, bytes);

		await cas.trash(cid);

		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(true);
		expect(fs.exists(`dirB/.trash/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/${relPath}`)).toBe(false);
		const obj = await meta.get(cid);
		expect(obj?.copies).toHaveLength(2);
		expect(obj?.copies?.every((c) => c.trashedAt instanceof Date)).toBe(
			true,
		);
	});

	it("deleteIfTrashed 删除回收站副本并清空回收站状态", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirA 正常，dirB 在回收站
		fs.write(`dirA/${relPath}`);
		fs.write(`dirB/.trash/${relPath}`);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA" }, { dir: "dirB", trashedAt: new Date() }],
		});

		const n = await cas.deleteIfTrashed(cid);

		expect(n).toBe(1);
		expect(fs.exists(`dirB/.trash/${relPath}`)).toBe(false);
		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		const obj = await meta.get(cid);
		// dirB 回收站条目被移除，仅剩 dirA 正常副本
		expect(obj?.copies?.find((c) => c.dir === "dirB")).toBeUndefined();
		expect(
			obj?.copies?.find((c) => c.dir === "dirA")?.trashedAt,
		).toBeUndefined();
	});

	it("load 恢复所有目录的回收站副本", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// 两个目录都在回收站（无正常副本）
		fs.write(`dirA/.trash/${relPath}`, bytes);
		fs.write(`dirB/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [
				{ dir: "dirA", trashedAt: new Date() },
				{ dir: "dirB", trashedAt: new Date() },
			],
		});

		const result = await cas.load(cid);

		expect(result?.didRestore).toBe(true);
		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		expect(fs.exists(`dirB/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
		expect(fs.exists(`dirB/.trash/${relPath}`)).toBe(false);
		const obj = await meta.get(cid);
		expect(obj?.copies?.every((c) => c.trashedAt === undefined)).toBe(true);
	});

	it("restoreIfTrashed 目标目录已有同 CID 正常副本时不抛错并去重", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirA 有正常副本；dirB 有正常副本 + 同 CID 的回收站副本
		fs.write(`dirA/${relPath}`, bytes);
		fs.write(`dirB/${relPath}`, bytes);
		fs.write(`dirB/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [
				{ dir: "dirA" },
				{ dir: "dirB" },
				{ dir: "dirB", trashedAt: new Date() },
			],
		});

		// 不应抛 "Destination file already exists!"
		const didRestore = await cas.restoreIfTrashed(cid);

		expect(didRestore).toBe(true);
		// 重复的 .trash 副本被删除，正常副本保留
		expect(fs.exists(`dirB/.trash/${relPath}`)).toBe(false);
		expect(fs.exists(`dirB/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		const obj = await meta.get(cid);
		expect(obj?.copies?.every((c) => c.trashedAt === undefined)).toBe(true);
	});

	it("restoreIfTrashed 副本所在目录不在允许列表内时迁移到列表第一个目录", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA", trashedAt: new Date() }],
		});

		const didRestore = await cas.restoreIfTrashed(cid, ["dirB"]);

		expect(didRestore).toBe(true);
		// 迁移到列表第一个目录 dirB，源目录不留任何副本
		expect(fs.exists(`dirB/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
		expect(fs.exists(`dirA/${relPath}`)).toBe(false);
		const obj = await meta.get(cid);
		expect(obj?.copies).toEqual([{ dir: "dirB", trashedAt: undefined }]);
	});

	it("restoreIfTrashed 副本所在目录在允许列表内时原位恢复", async () => {
		const { cas, meta, fs } = setup(["dirA"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA", trashedAt: new Date() }],
		});

		await cas.restoreIfTrashed(cid, ["dirA"]);

		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
	});

	it("restoreIfTrashed 允许列表为空时原位恢复（回归现状）", async () => {
		const { cas, meta, fs } = setup(["dirA"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA", trashedAt: new Date() }],
		});

		await cas.restoreIfTrashed(cid, []);

		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
	});

	it("restoreIfTrashed 迁移后元数据只记录实际目标目录，不残留源目录", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		// dirA 有正常副本；dirB 有回收站副本；允许列表 [dirA]
		fs.write(`dirA/${relPath}`, bytes);
		fs.write(`dirB/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA" }, { dir: "dirB", trashedAt: new Date() }],
		});

		const didRestore = await cas.restoreIfTrashed(cid, ["dirA"]);

		expect(didRestore).toBe(true);
		// dirB 回收站副本迁入 dirA；dirA 已有同内容正常副本 → 去重删除源
		expect(fs.exists(`dirB/.trash/${relPath}`)).toBe(false);
		expect(fs.exists(`dirB/${relPath}`)).toBe(false);
		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		const obj = await meta.get(cid);
		expect(obj?.copies).toEqual([{ dir: "dirA", trashedAt: undefined }]);
	});

	it("load 副本所在目录不在允许列表内时迁移到列表第一个目录", async () => {
		const { cas, meta, fs } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA", trashedAt: new Date() }],
		});

		const result = await cas.load(cid, ["dirB"]);

		expect(result?.didRestore).toBe(true);
		expect(result?.normalizedPath).toBe(`dirB/${relPath}`);
		expect(fs.exists(`dirB/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
		const obj = await meta.get(cid);
		expect(obj?.copies).toEqual([{ dir: "dirB", trashedAt: undefined }]);
	});

	it("load 副本所在目录在允许列表内时原位恢复", async () => {
		const { cas, meta, fs } = setup(["dirA"]);
		const { cid, bytes } = await makeObject("abc");
		const relPath = cas.formatRelPath(cid);
		fs.write(`dirA/.trash/${relPath}`, bytes);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "dirA", trashedAt: new Date() }],
		});

		const result = await cas.load(cid, ["dirA"]);

		expect(result?.didRestore).toBe(true);
		expect(result?.normalizedPath).toBe(`dirA/${relPath}`);
		expect(fs.exists(`dirA/${relPath}`)).toBe(true);
		expect(fs.exists(`dirA/.trash/${relPath}`)).toBe(false);
	});

	it("copies 记录未删除的多目录副本信息（代表有外部写入）", async () => {
		const { cas, meta } = setup(["dirA", "dirB"]);
		const { cid, bytes } = await makeObject("abc");

		await cas.save(
			"dirA",
			new File([bytes], "a.png", { type: "image/png" }),
		);
		await cas.save(
			"dirB",
			new File([bytes], "b.png", { type: "image/png" }),
		);

		const obj = await meta.get(cid);
		expect(obj?.copies).toHaveLength(2);
		expect(obj?.copies?.map((c) => c.dir).sort()).toEqual(["dirA", "dirB"]);
		expect(obj?.copies?.every((c) => c.trashedAt === undefined)).toBe(true);
	});
});

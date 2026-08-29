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
		return this.files.has(path);
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

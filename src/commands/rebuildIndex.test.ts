/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import rebuildIndex from "./rebuildIndex";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

/** 内存元数据，merge 为整条覆盖 */
class MemMeta implements CASMetadata {
	map = new Map<string, CASMetadataObject>();

	async get(cid: CID) {
		return this.map.get(cid.toString());
	}
	async merge(obj: CASMetadataObject) {
		const didCreate = !this.map.has(obj.cid.toString());
		this.map.set(obj.cid.toString(), obj);
		return { didCreate };
	}
	async delete(cid: CID) {
		this.map.delete(cid.toString());
	}
	async *find() {
		for (const obj of this.map.values()) {
			yield { node: obj, cursor: obj.cid.toString() };
		}
	}
	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0 };
	}
}

async function makeObject(
	content: string,
	copies: CASMetadataObject["copies"],
) {
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256.digest(bytes);
	const cid = CID.create(1, raw.code, hash);
	return {
		cid,
		obj: { cid, indexedAt: new Date(), copies, size: bytes.length },
	};
}

function refManager(reference: Set<string>) {
	return {
		count: vi.fn(async (cid: CID) =>
			reference.has(cid.toString()) ? 1 : 0,
		),
		clearCache: vi.fn(async () => {}),
	};
}

function fakeCas(onDisk: CASMetadataObject[]): CAS {
	return {
		objects: async function* () {
			for (const obj of onDisk) yield obj;
		},
	} as unknown as CAS;
}

describe("rebuildIndex 对账清理", () => {
	it("扫描覆盖的记录保留并标记 lastVisitedAt，不误删", async () => {
		const { cid, obj } = await makeObject("abc", [
			{ dir: "a", trashedAt: new Date(1) },
		]);
		const meta = new MemMeta();
		await meta.merge({ cid, indexedAt: new Date(), copies: [] });
		const rm = refManager(new Set());

		await rebuildIndex(fakeCas([obj]), meta, rm as never);

		const node = await meta.get(cid);
		expect(node).toBeDefined();
		expect(node?.lastVisitedAt).toBeInstanceOf(Date);
		expect(node?.copies).toEqual(obj.copies);
	});

	it("磁盘无副本且无引用：删除残留记录", async () => {
		const { cid, obj } = await makeObject("gone", [
			{ dir: "a", trashedAt: new Date(1) },
		]);
		void obj;
		const meta = new MemMeta();
		// 磁盘上已无该 cid，仅残留元数据（回收站标记）
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "a", trashedAt: new Date(1) }],
		});
		const rm = refManager(new Set());

		await rebuildIndex(fakeCas([]), meta, rm as never);

		expect(await meta.get(cid)).toBeUndefined();
	});

	it("磁盘无副本但被引用：保留记录清空回收标记", async () => {
		const { cid, obj } = await makeObject("refd", [
			{ dir: "a", trashedAt: new Date(1) },
		]);
		void obj;
		const meta = new MemMeta();
		await meta.merge({
			cid,
			indexedAt: new Date(),
			filename: "a.png",
			copies: [{ dir: "a", trashedAt: new Date(1) }],
		});
		const rm = refManager(new Set([cid.toString()]));

		await rebuildIndex(fakeCas([]), meta, rm as never);

		const node = await meta.get(cid);
		expect(node).toBeDefined();
		// 记录与引用元数据（filename）保留，副本清空 → 退出回收站
		expect(node?.filename).toBe("a.png");
		expect(node?.copies).toEqual([]);
		expect(node?.lastVisitedAt).toBeInstanceOf(Date);
	});

	it("磁盘仍有正常副本：merge 覆盖回收标记为该目录正常实例，不清理", async () => {
		const { cid, obj } = await makeObject("normal", [
			{ dir: "a", trashedAt: undefined },
		]);
		const meta = new MemMeta();
		// 磁盘其实是正常副本，但元数据残留回收标记
		await meta.merge({
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "a", trashedAt: new Date(1) }],
		});
		const rm = refManager(new Set());

		await rebuildIndex(fakeCas([obj]), meta, rm as never);

		const node = await meta.get(cid);
		expect(node).toBeDefined();
		// 回收标记被覆盖为正常副本
		expect(node?.copies?.every((c) => c.trashedAt === undefined)).toBe(
			true,
		);
	});
});

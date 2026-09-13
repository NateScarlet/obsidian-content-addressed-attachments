/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import rebuildIndex, { DEFAULT_MERGE_BATCH_SIZE } from "./rebuildIndex";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

/** 内存元数据，merge 为整条覆盖并记录每次调用（含信号） */
class MemMeta implements CASMetadata {
	map = new Map<string, CASMetadataObject>();
	mergeCalls: {
		obj: CASMetadataObject;
		signal: AbortSignal | undefined;
	}[] = [];

	async get(cid: CID) {
		return this.map.get(cid.toString());
	}
	async merge(obj: CASMetadataObject, signal?: AbortSignal) {
		this.mergeCalls.push({ obj, signal });
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

/** 生成 n 个不同内容（不同 CID）的磁盘对象 */
async function makeObjects(n: number) {
	const objects: CASMetadataObject[] = [];
	for (let i = 0; i < n; i++) {
		const { obj } = await makeObject(`content-${i}`, []);
		objects.push(obj);
	}
	return objects;
}

describe("rebuildIndex 批量写入", () => {
	it("磁盘对象块内并行 merge，默认块大小分块", async () => {
		const onDisk = await makeObjects(DEFAULT_MERGE_BATCH_SIZE + 1);
		const meta = new MemMeta();
		const rm = refManager(new Set());

		const { scanned } = await rebuildIndex(
			fakeCas(onDisk),
			meta,
			rm as never,
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(scanned).toBe(DEFAULT_MERGE_BATCH_SIZE + 1);
		// 逐条 merge 调用，共 n 次（块内并行；块边界由进度回调覆盖断言）
		expect(meta.mergeCalls).toHaveLength(DEFAULT_MERGE_BATCH_SIZE + 1);
		// 全部记录写入元数据
		for (const obj of onDisk) {
			expect(await meta.get(obj.cid)).toBeDefined();
		}
	});

	it("逐条 merge 均收到与传入重建命令相同的 signal", async () => {
		const onDisk = await makeObjects(3);
		const meta = new MemMeta();
		const rm = refManager(new Set());
		const controller = new AbortController();

		await rebuildIndex(fakeCas(onDisk), meta, rm as never, undefined, {
			signal: controller.signal,
		});

		expect(meta.mergeCalls.length).toBeGreaterThan(0);
		for (const call of meta.mergeCalls) {
			expect(call.signal).toBe(controller.signal);
		}
	});

	it("进度按块推进：每写完一块回调一次，值为已处理累计数", async () => {
		const onDisk = await makeObjects(DEFAULT_MERGE_BATCH_SIZE + 2);
		const meta = new MemMeta();
		const rm = refManager(new Set());
		const onProgress = vi.fn();

		await rebuildIndex(fakeCas(onDisk), meta, rm as never, onProgress, {
			signal: new AbortController().signal,
		});

		// 每块一次回调，值为该块末尾的累计数
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenNthCalledWith(
			1,
			DEFAULT_MERGE_BATCH_SIZE,
			expect.any(String),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			DEFAULT_MERGE_BATCH_SIZE + 2,
			expect.any(String),
		);
	});

	it("信号已中止时抛出 AbortError 且不再调用 merge", async () => {
		const onDisk = await makeObjects(3);
		const meta = new MemMeta();
		const rm = refManager(new Set());
		const controller = new AbortController();
		controller.abort();

		await expect(
			rebuildIndex(fakeCas(onDisk), meta, rm as never, undefined, {
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(meta.mergeCalls).toHaveLength(0);
	});
});

describe("rebuildIndex 对账清理", () => {
	it("扫描覆盖的记录保留并标记 lastVisitedAt，不误删", async () => {
		const { cid, obj } = await makeObject("abc", [
			{ dir: "a", trashedAt: new Date(1) },
		]);
		const meta = new MemMeta();
		await meta.merge({ cid, indexedAt: new Date(), copies: [] });
		const rm = refManager(new Set());

		await rebuildIndex(fakeCas([obj]), meta, rm as never, undefined, {
			signal: new AbortController().signal,
		});

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

		await rebuildIndex(fakeCas([]), meta, rm as never, undefined, {
			signal: new AbortController().signal,
		});

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

		await rebuildIndex(fakeCas([]), meta, rm as never, undefined, {
			signal: new AbortController().signal,
		});

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

		await rebuildIndex(fakeCas([obj]), meta, rm as never, undefined, {
			signal: new AbortController().signal,
		});

		const node = await meta.get(cid);
		expect(node).toBeDefined();
		// 回收标记被覆盖为正常副本
		expect(node?.copies?.every((c) => c.trashedAt === undefined)).toBe(
			true,
		);
	});
});

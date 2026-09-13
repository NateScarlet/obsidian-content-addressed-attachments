/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import cleanUnreferenced from "./cleanUnreferenced";
import type { CAS } from "#src/types/CAS";
import type {
	CASMetadata,
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "#src/types/CASMetadata";
import { isCASObjectTrashed } from "#src/utils/casCopies";

/**
 * 内存元数据：find 依 filterBy 产出。命令级 seam 迁移后，命令不再直接持有
 * referenceManager 做引用判定——"hasReference:false" 筛选由数据层（casMetadata.find）
 * 消费侧负责，这里用一个 unreferenced 集合模拟其筛选结果，仅对外部行为（回收与进度）断言。
 */
class MemMeta implements CASMetadata {
	nodes: CASMetadataObject[] = [];
	/** find(hasReference:false) 应产出的 cid 集合（模拟数据层引用筛选结果） */
	unreferenced = new Set<string>();

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
		const index = this.nodes.findIndex((i) => i.cid.equals(cid));
		if (index >= 0) {
			this.nodes.splice(index, 1);
		}
	}
	async *find(options: { filterBy?: CASMetadataObjectFilters } = {}) {
		const filterBy = options.filterBy ?? {};
		for (const node of this.nodes) {
			if (filterBy.isTrashed != null) {
				if (isCASObjectTrashed(node) !== filterBy.isTrashed) {
					continue;
				}
			}
			if (filterBy.hasReference === false) {
				if (this.unreferenced.has(node.cid.toString())) {
					yield { node, cursor: node.cid.toString() };
				}
				continue;
			}
			yield { node, cursor: node.cid.toString() };
		}
	}
	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0 };
	}
}

async function makeObject(content: string) {
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256.digest(bytes);
	const cid = CID.create(1, raw.code, hash);
	return {
		cid,
		obj: { cid, indexedAt: new Date(), copies: [] } as CASMetadataObject,
	};
}

function fakeCas(trashBehavior?: (cid: CID) => Promise<number>) {
	const trashed: string[] = [];
	const trash = vi.fn(async (cid: CID) => {
		trashed.push(cid.toString());
		if (trashBehavior) {
			return trashBehavior(cid);
		}
		return 1;
	});
	return {
		cas: { trash } as unknown as CAS,
		trashed,
		trash,
	};
}

describe("cleanUnreferenced 清理未引用文件", () => {
	it("仅回收 find(hasReference:false) 选出的未引用文件，被引用文件不动", async () => {
		const a = await makeObject("a");
		const b = await makeObject("b");
		const meta = new MemMeta();
		meta.nodes = [a.obj, b.obj];
		// 模拟数据层引用筛选：只有 a 未引用
		meta.unreferenced = new Set([a.cid.toString()]);
		const { cas, trashed, trash } = fakeCas();

		const { cleaned } = await cleanUnreferenced(cas, meta, undefined, {
			signal: new AbortController().signal,
		});

		expect(cleaned).toBe(1);
		expect(trashed).toEqual([a.cid.toString()]);
		expect(trash).not.toHaveBeenCalledWith(b.cid);
	});

	it("已回收且未引用的条目不在清理范围（isTrashed:false 口径）", async () => {
		const a = await makeObject("a");
		a.obj.copies = [{ dir: "CAS", trashedAt: new Date() }];
		const meta = new MemMeta();
		meta.nodes = [a.obj];
		meta.unreferenced = new Set([a.cid.toString()]);
		const { cas, trash } = fakeCas();

		const { cleaned } = await cleanUnreferenced(cas, meta, undefined, {
			signal: new AbortController().signal,
		});

		expect(cleaned).toBe(0);
		expect(trash).not.toHaveBeenCalled();
	});

	it("进度仅清理阶段：每移入一个文件回调一次", async () => {
		const objs = await Promise.all(
			["x", "y", "z"].map((i) => makeObject(i)),
		);
		const meta = new MemMeta();
		meta.nodes = objs.map((i) => i.obj);
		// 未引用：x, y（z 被引用，不应产出）
		meta.unreferenced = new Set([
			objs[0].cid.toString(),
			objs[1].cid.toString(),
		]);
		const { cas, trashed } = fakeCas();
		const onProgress = vi.fn();

		await cleanUnreferenced(cas, meta, onProgress, {
			signal: new AbortController().signal,
		});

		expect(trashed).toHaveLength(2);
		expect(onProgress).toHaveBeenCalledTimes(2);
		const calls = onProgress.mock.calls as [number, string, "cleaning"][];
		// 清理计数 = 已真实移动的文件数（1..2）
		expect(calls.map(([index]) => index)).toEqual([1, 2]);
		expect(calls.every(([, , phase]) => phase === "cleaning")).toBe(true);
	});

	it("计数以实际移动为准：trash 返回 0（无副本/已在回收站）不计入且不推进清理进度", async () => {
		const a = await makeObject("a");
		const meta = new MemMeta();
		meta.nodes = [a.obj];
		meta.unreferenced = new Set([a.cid.toString()]);
		// 模拟第二轮清理：对象已被处理过，trash 无实际移动（返回 0）
		const { cas, trash } = fakeCas(async () => 0);
		const onProgress = vi.fn();

		const { cleaned } = await cleanUnreferenced(cas, meta, onProgress, {
			signal: new AbortController().signal,
		});

		expect(trash).toHaveBeenCalledTimes(1);
		expect(cleaned).toBe(0);
		expect(onProgress).toHaveBeenCalledTimes(0);
	});

	it("信号已中止时立即抛出，不回收任何文件", async () => {
		const a = await makeObject("a");
		const meta = new MemMeta();
		meta.nodes = [a.obj];
		meta.unreferenced = new Set([a.cid.toString()]);
		const { cas, trash } = fakeCas();
		const controller = new AbortController();
		controller.abort();

		await expect(
			cleanUnreferenced(cas, meta, undefined, {
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(trash).not.toHaveBeenCalled();
	});
});

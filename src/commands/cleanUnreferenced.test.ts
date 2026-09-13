/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import cleanUnreferenced from "./cleanUnreferenced";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

/** 内存元数据：find 产出全部记录，引用判定由 mock 的 referenceManager 承担 */
class MemMeta implements CASMetadata {
	nodes: CASMetadataObject[] = [];

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
	async *find() {
		for (const node of this.nodes) {
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

function refManager(referenced: Set<string>) {
	return {
		/** 与实现契约一致：count 记录 skipVerify 传参，供命令级断言 */
		count: vi.fn(
			async (
				cid: CID,
				_limit: number,
				_signal: unknown,
				options?: unknown,
			) => {
				void options;
				return referenced.has(cid.toString()) ? 1 : 0;
			},
		),
		ensureFresh: vi.fn(async () => {}),
	};
}

describe("cleanUnreferenced 清理未引用文件", () => {
	it("仅回收未引用文件，被引用文件不动", async () => {
		const a = await makeObject("a");
		const b = await makeObject("b");
		const meta = new MemMeta();
		meta.nodes = [a.obj, b.obj];
		const { cas, trashed, trash } = fakeCas();
		const rm = refManager(new Set([b.cid.toString()]));

		const { scanned, cleaned } = await cleanUnreferenced(
			cas,
			meta,
			rm as never,
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(scanned).toBe(2);
		expect(cleaned).toBe(1);
		expect(trashed).toEqual([a.cid.toString()]);
		expect(trash).not.toHaveBeenCalledWith(b.cid);
	});

	it("引用检查经 skipVerify 路径（命令已前置缓存保证）", async () => {
		const a = await makeObject("a");
		const meta = new MemMeta();
		meta.nodes = [a.obj];
		const { cas } = fakeCas();
		const rm = refManager(new Set());

		await cleanUnreferenced(cas, meta, rm as never, undefined, {
			signal: new AbortController().signal,
		});

		const countMock = rm.count as unknown as ReturnType<typeof vi.fn>;
		expect(countMock).toHaveBeenCalledWith(
			a.cid,
			1,
			expect.any(AbortSignal),
			{ skipVerify: true },
		);
		// skipVerify 契约：判定前必须先完成缓存保证（ensureFresh）
		expect(rm.ensureFresh).toHaveBeenCalledTimes(1);
	});

	it("进度覆盖检查与回收两阶段（并行序：按集合+阶段断言）", async () => {
		const objs = await Promise.all(
			["x", "y", "z"].map((i) => makeObject(i)),
		);
		const meta = new MemMeta();
		meta.nodes = objs.map((i) => i.obj);
		const { cas } = fakeCas();
		const rm = refManager(new Set([objs[1].cid.toString()]));
		const onProgress = vi.fn();

		await cleanUnreferenced(cas, meta, rm as never, onProgress, {
			signal: new AbortController().signal,
		});

		// 检查阶段：每条元数据一次（3 条）；回收阶段：每回收一条一次（2 条）
		expect(onProgress).toHaveBeenCalledTimes(5);
		const calls = onProgress.mock.calls as [
			number,
			string,
			"scanning" | "cleaning",
		][];
		// 集合断言：不依赖并行下的精确全局顺序
		const scanningCids = calls
			.filter(([, , phase]) => phase === "scanning")
			.map(([, cidStr]) => cidStr);
		expect(new Set(scanningCids)).toEqual(
			new Set(objs.map((o) => o.cid.toString())),
		);
		const cleaningCalls = calls.filter(
			([, , phase]) => phase === "cleaning",
		);
		expect(cleaningCalls).toHaveLength(2);
		// 回收阶段 cid 均为未引用项
		expect(new Set(cleaningCalls.map(([, cidStr]) => cidStr))).toEqual(
			new Set([objs[0].cid.toString(), objs[2].cid.toString()]),
		);
	});

	it("各阶段计数语义正确：扫描条显示已检查数，清理条显示已移动数", async () => {
		const objs = await Promise.all(
			["x", "y", "z"].map((i) => makeObject(i)),
		);
		const meta = new MemMeta();
		meta.nodes = objs.map((i) => i.obj);
		const { cas } = fakeCas();
		const rm = refManager(new Set([objs[1].cid.toString()]));
		const onProgress = vi.fn();

		await cleanUnreferenced(cas, meta, rm as never, onProgress, {
			signal: new AbortController().signal,
		});

		const calls = onProgress.mock.calls as [
			number,
			string,
			"scanning" | "cleaning",
		][];
		// scanning 计数 = 已检查条数（1..3，与元数据总数一致）
		const scanningIndexes = calls
			.filter(([, , phase]) => phase === "scanning")
			.map(([index]) => index)
			.sort((a, b) => a - b);
		expect(scanningIndexes).toEqual([1, 2, 3]);
		// cleaning 计数 = 已真实移动的文件数（1..2）——
		// 绝不能把扫描计数灌进「移入回收站」的数字（会把几千条检查显示成移动了几千个文件）
		const cleaningCalls = calls.filter(
			([, , phase]) => phase === "cleaning",
		);
		expect(cleaningCalls.map(([index]) => index)).toEqual([1, 2]);
	});

	it("计数以实际移动为准：trash 返回 0（无副本/已在回收站）不计入且不推进清理进度", async () => {
		const a = await makeObject("a");
		const b = await makeObject("b");
		const meta = new MemMeta();
		meta.nodes = [a.obj, b.obj];
		// 模拟第二轮清理：对象已被处理过，trash 无实际移动（返回 0）
		const { cas, trash } = fakeCas(async () => 0);
		const rm = refManager(new Set());
		const onProgress = vi.fn();

		const { cleaned } = await cleanUnreferenced(
			cas,
			meta,
			rm as never,
			onProgress,
			{ signal: new AbortController().signal },
		);

		expect(trash).toHaveBeenCalledTimes(2);
		expect(cleaned).toBe(0);
		// cleaning 回调从未触发（无真实移动，「移入回收站」进度条不出现）
		const cleaningCalls = (
			onProgress.mock.calls as [number, string, "scanning" | "cleaning"][]
		).filter(([, , phase]) => phase === "cleaning");
		expect(cleaningCalls).toHaveLength(0);
	});

	it("信号已中止时立即抛出，不回收任何文件", async () => {
		const a = await makeObject("a");
		const meta = new MemMeta();
		meta.nodes = [a.obj];
		const { cas, trash } = fakeCas();
		const rm = refManager(new Set());
		const controller = new AbortController();
		controller.abort();

		await expect(
			cleanUnreferenced(cas, meta, rm as never, undefined, {
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(trash).not.toHaveBeenCalled();
	});
});

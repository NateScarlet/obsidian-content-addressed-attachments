/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import type { CID } from "multiformats";
import { CASMetadataSyncService } from "./CASMetadataSyncService";
import { casMetadataChanged } from "#src/events";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

/** 内存元数据 mock：记录 mergeBatch/delete 调用，供断言批量落地 */
class MemMeta implements CASMetadata {
	mergeBatch = vi.fn(
		async (objs: CASMetadataObject[], signal: AbortSignal) => {
			signal.throwIfAborted();
			return { didCreate: objs.length, didChange: objs.length };
		},
	);
	delete = vi.fn(async (_cid: CID, signal?: AbortSignal) => {
		signal?.throwIfAborted();
	});
	get = vi.fn(async () => undefined);
	merge = vi.fn(async () => ({ didCreate: true }));
	async *find() {}
	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0 };
	}
}

/** 内存 CAS mock：collectCopies 按预设磁盘事实返回 */
function makeCas(
	copiesByCid: Map<string, { dir: string; trashedAt?: Date }[]>,
) {
	return {
		collectCopies: vi.fn(async (cid: CID) => {
			return copiesByCid.get(cid.toString()) ?? [];
		}),
	} as unknown as CAS;
}

describe("CASMetadataSyncService", () => {
	it("按磁盘真相完整落地副本状态：含回收站副本一并保留", async () => {
		const meta = new MemMeta();
		// 磁盘事实：dirA 正常 + dirB 回收站（save 到 dirA 不应抹掉 dirB 回收状态）
		const cas = makeCas(
			new Map([
				[
					"abc",
					[
						{ dir: "dirA", trashedAt: undefined },
						{ dir: "dirB", trashedAt: new Date("2026-01-01") },
					],
				],
			]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "abc" as unknown as CID;
		casMetadataChanged.dispatch({ detail: { cid } });

		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(1);
		});
		const [objs] = meta.mergeBatch.mock.calls[0] as unknown as [
			CASMetadataObject[],
		];
		expect(objs).toHaveLength(1);
		expect(objs[0].copies).toEqual([
			{ dir: "dirA", trashedAt: undefined },
			{ dir: "dirB", trashedAt: new Date("2026-01-01") },
		]);

		service[Symbol.dispose]();
	});

	it("有副本的 CID 按磁盘真相 mergeBatch 落地", async () => {
		const meta = new MemMeta();
		const cas = makeCas(
			new Map([["abc", [{ dir: "dirA", trashedAt: undefined }]]]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "abc" as unknown as CID;
		casMetadataChanged.dispatch({
			detail: {
				cid,
				filename: "a.png",
				format: "image/png",
				size: 42,
			},
		});

		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(1);
		});
		const [objs] = meta.mergeBatch.mock.calls[0] as unknown as [
			CASMetadataObject[],
		];
		expect(objs).toHaveLength(1);
		expect(objs[0].cid.toString()).toBe("abc");
		expect(objs[0].filename).toBe("a.png");
		expect(objs[0].format).toBe("image/png");
		expect(objs[0].size).toBe(42);
		expect(objs[0].copies).toEqual([{ dir: "dirA", trashedAt: undefined }]);
		// 有副本时不做 delete
		expect(meta.delete).not.toHaveBeenCalled();

		service[Symbol.dispose]();
	});

	it("磁盘无副本的 CID 做 delete 而非 merge", async () => {
		const meta = new MemMeta();
		const cas = makeCas(new Map());
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "abc" as unknown as CID;
		casMetadataChanged.dispatch({ detail: { cid } });

		await vi.waitFor(() => {
			expect(meta.delete).toHaveBeenCalledTimes(1);
		});
		expect(meta.delete).toHaveBeenCalledWith(cid, expect.any(AbortSignal));
		expect(meta.mergeBatch).not.toHaveBeenCalled();

		service[Symbol.dispose]();
	});

	it("同批到达的多个 CID 折叠为一次 mergeBatch", async () => {
		const meta = new MemMeta();
		const cas = makeCas(
			new Map([
				["a", [{ dir: "dirA", trashedAt: undefined }]],
				["b", [{ dir: "dirB", trashedAt: undefined }]],
			]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const a = "a" as unknown as CID;
		const b = "b" as unknown as CID;

		casMetadataChanged.dispatch({ detail: { cid: a } });
		casMetadataChanged.dispatch({ detail: { cid: b } });

		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(1);
		});
		const [objs] = meta.mergeBatch.mock.calls[0] as unknown as [
			CASMetadataObject[],
		];
		expect(objs.map((o) => o.cid.toString()).sort()).toEqual(["a", "b"]);

		service[Symbol.dispose]();
	});

	it("同一 CID 的多次信号折叠为最后一次（幂等，不乱序回退）", async () => {
		const meta = new MemMeta();
		const cas = makeCas(
			new Map([["a", [{ dir: "dirA", trashedAt: undefined }]]]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "a" as unknown as CID;

		casMetadataChanged.dispatch({ detail: { cid, filename: "old.png" } });
		casMetadataChanged.dispatch({ detail: { cid, filename: "mid.png" } });
		casMetadataChanged.dispatch({ detail: { cid, filename: "new.png" } });

		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(1);
		});
		const [objs] = meta.mergeBatch.mock.calls[0] as unknown as [
			CASMetadataObject[],
		];
		expect(objs).toHaveLength(1);
		expect(objs[0].filename).toBe("new.png");

		service[Symbol.dispose]();
	});

	it("写失败不阻断后续处理，且不依赖日志（可见反馈由组装方决定）", async () => {
		const meta = new MemMeta();
		// 第一次 mergeBatch 抛错，第二次成功
		meta.mergeBatch.mockRejectedValueOnce(new Error("idb busy"));
		const cas = makeCas(
			new Map([["a", [{ dir: "dirA", trashedAt: undefined }]]]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "a" as unknown as CID;

		casMetadataChanged.dispatch({ detail: { cid } });
		// 等待第一次（失败）处理完，再触发新变动
		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(1);
		});
		casMetadataChanged.dispatch({ detail: { cid } });

		await vi.waitFor(() => {
			expect(meta.mergeBatch).toHaveBeenCalledTimes(2);
		});
		// 服务不因失败而永久卡死

		service[Symbol.dispose]();
	});

	it("dispose 后不再消费事件", async () => {
		const meta = new MemMeta();
		const cas = makeCas(
			new Map([["a", [{ dir: "dirA", trashedAt: undefined }]]]),
		);
		const service = new CASMetadataSyncService(
			cas,
			meta,
			new AbortController().signal,
		);
		const cid = "a" as unknown as CID;

		service[Symbol.dispose]();
		casMetadataChanged.dispatch({ detail: { cid } });

		// 给微任务机会，断言没有触发
		await Promise.resolve();
		expect(meta.mergeBatch).not.toHaveBeenCalled();
		expect(meta.delete).not.toHaveBeenCalled();
	});
});

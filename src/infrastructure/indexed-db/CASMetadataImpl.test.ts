import { describe, it, expect } from "vitest";
import {
	removePlaceholderCopies,
	normalizePOForStaleV1,
	buildMergedPO,
} from "./CASMetadataImpl";

describe("buildMergedPO 合并持久化对象", () => {
	const existing = {
		cid: "x",
		indexedAt: 1,
		filename: "a.png",
		format: "image/png",
		size: 100,
		copies: [{ dir: "dirA", trashedAt: undefined }],
	};

	it("无既有记录时直接返回 incoming", () => {
		const incoming = { cid: "y", indexedAt: 2, size: 3 };
		expect(buildMergedPO(incoming, undefined)).toBe(incoming);
	});

	it("partial 更新缺失字段时保留既有 format/filename/size（重点）", () => {
		// 模拟重建索引/index：只带 cid、indexedAt、copies（无 format/filename/size）
		const result = buildMergedPO(
			{
				cid: "x",
				indexedAt: 2,
				copies: [{ dir: "dirA", trashedAt: undefined }],
			},
			existing,
		);
		expect(result.filename).toBe("a.png");
		expect(result.format).toBe("image/png");
		expect(result.size).toBe(100);
	});

	it("rebuilt 提供 size 时更新 size 但保留 format/filename", () => {
		// 重建索引扫描对象带 size（磁盘真实大小），但无 format/filename
		const result = buildMergedPO(
			{
				cid: "x",
				indexedAt: 2,
				size: 123,
				copies: [{ dir: "dirA", trashedAt: undefined }],
			},
			existing,
		);
		expect(result.size).toBe(123);
		expect(result.filename).toBe("a.png");
		expect(result.format).toBe("image/png");
	});

	it("incoming 显式提供新 format 时更新", () => {
		const result = buildMergedPO(
			{
				cid: "x",
				indexedAt: 2,
				format: "image/jpeg",
				copies: [{ dir: "dirA", trashedAt: undefined }],
			},
			existing,
		);
		expect(result.format).toBe("image/jpeg");
		expect(result.filename).toBe("a.png");
	});

	it("incoming 未提供 copies 时保留既有 copies", () => {
		const result = buildMergedPO({ cid: "x", indexedAt: 2 }, existing);
		expect(result.copies).toEqual(existing.copies);
	});

	it("incoming 提供真实 copies 时清理占位副本", () => {
		const existingWithPlaceholder = {
			...existing,
			copies: [{ dir: "", trashedAt: 1 }],
		};
		const result = buildMergedPO(
			{
				cid: "x",
				indexedAt: 2,
				copies: [{ dir: "dirB", trashedAt: undefined }],
			},
			existingWithPlaceholder,
		);
		expect(result.copies).toEqual([{ dir: "dirB", trashedAt: undefined }]);
	});

	describe("回收时间以既有记录为准", () => {
		const trashed = {
			cid: "x",
			indexedAt: 1,
			copies: [{ dir: "dirA", trashedAt: 1000 }],
		};

		it("同一副本已有回收时间时，保留该时间而不被磁盘修改时间覆盖", () => {
			// 扫描磁盘得到的 mtime 是内容修改时间，恒早于实际回收时刻
			const result = buildMergedPO(
				{
					cid: "x",
					indexedAt: 2,
					copies: [{ dir: "dirA", trashedAt: 500 }],
				},
				trashed,
			);
			expect(result.copies).toEqual([{ dir: "dirA", trashedAt: 1000 }]);
		});

		it("元数据里该副本尚无回收时间时，用磁盘修改时间填补（库外移入回收站）", () => {
			// 元数据里 dirA 还是正常副本，但磁盘上它已在回收站：没有既有回收时间可用
			const normal = {
				cid: "x",
				indexedAt: 1,
				copies: [{ dir: "dirA", trashedAt: undefined }],
			};
			const result = buildMergedPO(
				{
					cid: "x",
					indexedAt: 2,
					copies: [{ dir: "dirA", trashedAt: 500 }],
				},
				normal,
			);
			expect(result.copies).toEqual([{ dir: "dirA", trashedAt: 500 }]);
		});

		it("既有副本已恢复正常时不保留其回收时间", () => {
			const result = buildMergedPO(
				{
					cid: "x",
					indexedAt: 2,
					copies: [{ dir: "dirA", trashedAt: undefined }],
				},
				trashed,
			);
			expect(result.copies).toEqual([
				{ dir: "dirA", trashedAt: undefined },
			]);
		});

		it("磁盘已无该副本时该副本被移除，不复活", () => {
			const result = buildMergedPO(
				{
					cid: "x",
					indexedAt: 2,
					copies: [{ dir: "dirB", trashedAt: undefined }],
				},
				trashed,
			);
			expect(result.copies).toEqual([
				{ dir: "dirB", trashedAt: undefined },
			]);
		});

		it("同一目录同时存在正常与回收实例时，回收时间按实例匹配", () => {
			const both = {
				cid: "x",
				indexedAt: 1,
				copies: [
					{ dir: "dirA", trashedAt: undefined },
					{ dir: "dirA", trashedAt: 1000 },
				],
			};
			const result = buildMergedPO(
				{
					cid: "x",
					indexedAt: 2,
					copies: [
						{ dir: "dirA", trashedAt: undefined },
						{ dir: "dirA", trashedAt: 500 },
					],
				},
				both,
			);
			expect(result.copies).toEqual([
				{ dir: "dirA", trashedAt: undefined },
				{ dir: "dirA", trashedAt: 1000 },
			]);
		});

		// 规则落在 merge 必经点，各写入方无需自行处理；
		// 下面按各写入方实际传入的 copies 形态核对继承结果。
		describe("各写入方经必经点继承该规则", () => {
			const trashedAt = 1000;

			it("重建扫描（磁盘全集）保留既有回收时间", () => {
				const result = buildMergedPO(
					{
						cid: "x",
						indexedAt: 2,
						copies: [
							{ dir: "dirA", trashedAt: undefined },
							{ dir: "dirB", trashedAt: 500 },
						],
					},
					{
						cid: "x",
						indexedAt: 1,
						copies: [
							{ dir: "dirA", trashedAt: undefined },
							{ dir: "dirB", trashedAt },
						],
					},
				);
				expect(result.copies).toEqual([
					{ dir: "dirA", trashedAt: undefined },
					{ dir: "dirB", trashedAt },
				]);
			});

			it("保存/索引（本目录正常副本）不清空其他目录的回收时间", () => {
				const result = buildMergedPO(
					{
						cid: "x",
						indexedAt: 2,
						copies: [
							{ dir: "dirA", trashedAt: undefined },
							{ dir: "dirB", trashedAt },
						],
					},
					{
						cid: "x",
						indexedAt: 1,
						copies: [
							{ dir: "dirA", trashedAt: undefined },
							{ dir: "dirB", trashedAt },
						],
					},
				);
				expect(result.copies).toEqual([
					{ dir: "dirA", trashedAt: undefined },
					{ dir: "dirB", trashedAt },
				]);
			});

			it("清空回收站（仅剩正常副本）丢弃已删除副本的回收时间", () => {
				const result = buildMergedPO(
					{
						cid: "x",
						indexedAt: 2,
						copies: [{ dir: "dirA", trashedAt: undefined }],
					},
					{
						cid: "x",
						indexedAt: 1,
						copies: [
							{ dir: "dirA", trashedAt: undefined },
							{ dir: "dirB", trashedAt },
						],
					},
				);
				expect(result.copies).toEqual([
					{ dir: "dirA", trashedAt: undefined },
				]);
			});

			it("恢复（全部转为正常）不残留回收时间", () => {
				const result = buildMergedPO(
					{
						cid: "x",
						indexedAt: 2,
						copies: [{ dir: "dirA", trashedAt: undefined }],
					},
					{
						cid: "x",
						indexedAt: 1,
						copies: [{ dir: "dirA", trashedAt }],
					},
				);
				expect(result.copies).toEqual([
					{ dir: "dirA", trashedAt: undefined },
				]);
			});

			it("移入回收站（记录移动时刻）时该时刻成为既有值", () => {
				const result = buildMergedPO(
					{
						cid: "x",
						indexedAt: 2,
						copies: [{ dir: "dirA", trashedAt: 1200 }],
					},
					{
						cid: "x",
						indexedAt: 1,
						copies: [{ dir: "dirA", trashedAt: undefined }],
					},
				);
				// 元数据里尚无回收时间，首次记录由写入方给出
				expect(result.copies).toEqual([
					{ dir: "dirA", trashedAt: 1200 },
				]);
			});
		});
	});
});

describe("normalizePOForStaleV1 运行时兼容 v1 遗留数据", () => {
	it("有 copies 时保持不变", () => {
		const po = {
			cid: "x",
			indexedAt: 1,
			copies: [{ dir: "a", trashedAt: 2 }],
		};
		expect(normalizePOForStaleV1(po)).toBe(po);
	});

	it("无 copies 但有 trashedAt 时转占位副本并移除 trashedAt", () => {
		const result = normalizePOForStaleV1({
			cid: "x",
			indexedAt: 1,
			trashedAt: 5,
		});
		expect(result.copies).toEqual([{ dir: "", trashedAt: 5 }]);
		expect(result.trashedAt).toBeUndefined();
	});

	it("无 copies 且无 trashedAt 时保持不变", () => {
		const po = { cid: "x", indexedAt: 1 };
		expect(normalizePOForStaleV1(po)).toBe(po);
	});
});

describe("removePlaceholderCopies 清理迁移占位副本（存储层）", () => {
	it("无真实目录副本时保留占位", () => {
		const copies = [{ dir: "", trashedAt: 1 }];
		expect(removePlaceholderCopies(copies)).toEqual(copies);
	});

	it("出现真实目录副本时移除占位", () => {
		const result = removePlaceholderCopies([
			{ dir: "", trashedAt: 1 },
			{ dir: "dirA", trashedAt: 2 },
		]);
		expect(result).toEqual([{ dir: "dirA", trashedAt: 2 }]);
	});

	it("真实目录副本清除回收站状态时仍移除占位", () => {
		const result = removePlaceholderCopies([
			{ dir: "", trashedAt: 1 },
			{ dir: "dirA", trashedAt: undefined },
		]);
		expect(result).toEqual([{ dir: "dirA", trashedAt: undefined }]);
	});

	it("无占位副本时返回原数组", () => {
		const copies = [
			{ dir: "dirA", trashedAt: undefined },
			{ dir: "dirB", trashedAt: 2 },
		];
		expect(removePlaceholderCopies(copies)).toBe(copies);
	});
});

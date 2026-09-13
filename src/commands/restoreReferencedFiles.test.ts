/* eslint-disable @typescript-eslint/require-await -- 测试 mock 为同步内存实现 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import restoreReferencedFiles from "./restoreReferencedFiles";
import allowedDirsForRestore from "#src/utils/allowedDirsForRestore";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";

async function makeCid(content: string) {
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256.digest(bytes);
	return CID.create(1, raw.code, hash);
}

function setup() {
	const restoreIfTrashed = vi.fn().mockResolvedValue(true);
	const cas = { restoreIfTrashed } as unknown as CAS;
	const hasIPFSReference = vi.fn();
	const referenceManager = {
		hasIPFSReference,
	} as unknown as ReferenceManager;
	const metadata: CASMetadata = {
		get: vi.fn(),
		find: async function* () {},
	} as unknown as CASMetadata;
	return {
		cas,
		restoreIfTrashed,
		hasIPFSReference,
		referenceManager,
		metadata,
	};
}

describe("allowedDirsForRestore 映射规则", () => {
	it("存在 ipfs:// 引用 → 只允许主存储目录", () => {
		expect(allowedDirsForRestore(true, "primary", ["download"])).toEqual([
			"primary",
		]);
	});

	it("仅锁定引用 → 允许下载目录列表", () => {
		expect(allowedDirsForRestore(false, "primary", ["download"])).toEqual([
			"download",
		]);
	});

	it("仅锁定引用且下载目录为空 → undefined（原位恢复）", () => {
		expect(allowedDirsForRestore(false, "primary", [])).toBeUndefined();
	});
});

describe("restoreReferencedFiles 局部恢复", () => {
	it("cid 存在 ipfs:// 引用时以主存储目录作为允许列表恢复", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cid = await makeCid("a");
		const meta: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "primary", trashedAt: new Date() }],
		};
		vi.mocked(metadata.get).mockResolvedValue(meta);
		hasIPFSReference.mockResolvedValue(true);

		const count = await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: ["download"],
			cids: [cid],
		});

		expect(count).toBe(1);
		const [receivedCid, receivedDirs] = restoreIfTrashed.mock.calls[0];
		expect((receivedCid as CID).equals(cid)).toBe(true);
		expect(receivedDirs).toEqual(["primary"]);
	});

	it("cid 仅锁定引用时以下载目录列表作为允许列表恢复", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cid = await makeCid("a");
		const meta: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "download", trashedAt: new Date() }],
		};
		vi.mocked(metadata.get).mockResolvedValue(meta);
		hasIPFSReference.mockResolvedValue(false);

		await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: ["download"],
			cids: [cid],
		});

		const [, receivedDirs] = restoreIfTrashed.mock.calls[0];
		expect(receivedDirs).toEqual(["download"]);
	});

	it("仅锁定引用且下载目录为空时不传允许列表（原位恢复）", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cid = await makeCid("a");
		const meta: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "primary", trashedAt: new Date() }],
		};
		vi.mocked(metadata.get).mockResolvedValue(meta);
		hasIPFSReference.mockResolvedValue(false);

		await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: [],
			cids: [cid],
		});

		const [, receivedDirs] = restoreIfTrashed.mock.calls[0];
		expect(receivedDirs).toBeUndefined();
	});

	it("触发笔记已以 ipfs:// 形式引用该 cid 时短路，不查询全库", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cid = await makeCid("a");
		const meta: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "primary", trashedAt: new Date() }],
		};
		vi.mocked(metadata.get).mockResolvedValue(meta);

		await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: ["download"],
			cids: [cid],
			knownIPFSCids: new Set([cid.toString()]),
		});

		expect(hasIPFSReference).not.toHaveBeenCalled();
		const [, receivedDirs] = restoreIfTrashed.mock.calls[0];
		expect(receivedDirs).toEqual(["primary"]);
	});

	it("元数据未标记为已删除的 cid 不触发恢复", async () => {
		const { cas, restoreIfTrashed, referenceManager, metadata } = setup();
		const cid = await makeCid("a");
		const meta: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "primary" }],
		};
		vi.mocked(metadata.get).mockResolvedValue(meta);

		await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: [],
			cids: [cid],
		});

		expect(restoreIfTrashed).not.toHaveBeenCalled();
	});
});

describe("restoreReferencedFiles 全量恢复", () => {
	it("逐个 cid 查询引用类型并按映射传允许列表", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cidA = await makeCid("a");
		const cidB = await makeCid("b");
		const nodeA: CASMetadataObject = {
			cid: cidA,
			indexedAt: new Date(),
			copies: [{ dir: "primary", trashedAt: new Date() }],
		};
		const nodeB: CASMetadataObject = {
			cid: cidB,
			indexedAt: new Date(),
			copies: [{ dir: "download", trashedAt: new Date() }],
		};
		metadata.find = async function* () {
			yield { node: nodeA, cursor: cidA.toString() };
			yield { node: nodeB, cursor: cidB.toString() };
		};
		hasIPFSReference.mockImplementation(async (cid: CID) =>
			cid.equals(cidA),
		);

		const count = await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: ["download"],
		});

		expect(count).toBe(2);
		expect(hasIPFSReference).toHaveBeenCalledTimes(2);
		// cidA 有 ipfs:// 引用 → 主存储目录；cidB 仅锁定 → 下载目录
		const [firstCid, firstDirs] = restoreIfTrashed.mock.calls[0];
		expect((firstCid as CID).equals(cidA)).toBe(true);
		expect(firstDirs).toEqual(["primary"]);
		const [secondCid, secondDirs] = restoreIfTrashed.mock.calls[1];
		expect((secondCid as CID).equals(cidB)).toBe(true);
		expect(secondDirs).toEqual(["download"]);
	});

	it("下载目录为空时全量路径不传允许列表", async () => {
		const {
			cas,
			restoreIfTrashed,
			hasIPFSReference,
			referenceManager,
			metadata,
		} = setup();
		const cid = await makeCid("a");
		const node: CASMetadataObject = {
			cid,
			indexedAt: new Date(),
			copies: [{ dir: "primary", trashedAt: new Date() }],
		};
		metadata.find = async function* () {
			yield { node, cursor: cid.toString() };
		};
		hasIPFSReference.mockResolvedValue(false);

		await restoreReferencedFiles(cas, metadata, {
			referenceManager,
			primaryDir: "primary",
			downloadDirs: [],
		});

		const [, receivedDirs] = restoreIfTrashed.mock.calls[0];
		expect(receivedDirs).toBeUndefined();
	});
});

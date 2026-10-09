import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import CASMetadataObjectFilterBuilder from "./CASMetadataObjectFilterBuilder";
import type ReferenceManager from "./ReferenceManager";
import type { CASMetadataObject } from "./types/CASMetadata";

async function makeCid(): Promise<CID> {
	return CID.create(1, 0x55, await sha256.digest(new Uint8Array([1, 2, 3])));
}

function makeObject(cid: CID): CASMetadataObject {
	return { cid, indexedAt: new Date() };
}

function makeBuilder(
	overrides: {
		ensureFresh?: () => Promise<void>;
		count?: () => Promise<number>;
	} = {},
) {
	const ensureFresh = vi.fn(
		overrides.ensureFresh ?? (() => Promise.resolve()),
	);
	const count = vi.fn(overrides.count ?? (() => Promise.resolve(0)));
	const referenceManager = {
		ensureFresh,
		count,
	} as unknown as ReferenceManager;
	const builder = new CASMetadataObjectFilterBuilder(referenceManager);
	return { builder, ensureFresh, count };
}

describe("CASMetadataObjectFilterBuilder 引用状态筛选", () => {
	it("默认（未开 unverifiedHasReference）时先 ensureFresh 再计数判定", async () => {
		const { builder, ensureFresh, count } = makeBuilder();
		const filter = builder.build({ hasReference: false });
		const obj = makeObject(await makeCid());
		expect(await filter(obj)).toBe(true);
		expect(ensureFresh).toHaveBeenCalledTimes(1);
		expect(count).toHaveBeenCalledWith(obj.cid, 1, undefined, {
			skipVerify: true,
		});
	});

	it("独立设置 unverifiedHasReference 时生效并跳过 ensureFresh（不依赖 hasReference）", async () => {
		const { builder, ensureFresh, count } = makeBuilder({
			count: () => Promise.resolve(0),
		});
		const filter = builder.build({ unverifiedHasReference: false });
		const obj = makeObject(await makeCid());
		// 无 hasReference 字段，仅凭 unverifiedHasReference 触发引用状态筛选
		expect(await filter(obj)).toBe(true);
		expect(ensureFresh).not.toHaveBeenCalled();
		expect(count).toHaveBeenCalledTimes(1);
	});

	it("unverifiedHasReference=false 但有引用（count>0）时不通过", async () => {
		const { builder, ensureFresh } = makeBuilder({
			count: () => Promise.resolve(1),
		});
		const filter = builder.build({ unverifiedHasReference: false });
		expect(await filter(makeObject(await makeCid()))).toBe(false);
		expect(ensureFresh).not.toHaveBeenCalled();
	});

	it("unverifiedHasReference=true 表示被引用时通过", async () => {
		const { builder, ensureFresh } = makeBuilder({
			count: () => Promise.resolve(2),
		});
		const filter = builder.build({ unverifiedHasReference: true });
		expect(await filter(makeObject(await makeCid()))).toBe(true);
		expect(ensureFresh).not.toHaveBeenCalled();
	});

	it("hasReference=false 且无引用（count=0）时通过", async () => {
		const { builder } = makeBuilder({ count: () => Promise.resolve(0) });
		const filter = builder.build({ hasReference: false });
		expect(await filter(makeObject(await makeCid()))).toBe(true);
	});

	it("hasReference=false 但有引用（count>0）时不通过", async () => {
		const { builder } = makeBuilder({ count: () => Promise.resolve(1) });
		const filter = builder.build({ hasReference: false });
		expect(await filter(makeObject(await makeCid()))).toBe(false);
	});

	it("hasReference=true 且有引用时通过", async () => {
		const { builder } = makeBuilder({ count: () => Promise.resolve(2) });
		const filter = builder.build({ hasReference: true });
		expect(await filter(makeObject(await makeCid()))).toBe(true);
	});
});

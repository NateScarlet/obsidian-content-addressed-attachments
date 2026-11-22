import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import DecryptedCache, {
	DecryptedCacheDirMissingError,
} from "./DecryptedCache";
import type { DecryptedResult } from "#src/lib/encryption/EncryptionService";

type Adapter = App["vault"]["adapter"];

function decrypted(dataBytes: number, mimeType = "image/png"): DecryptedResult {
	return {
		data: new ArrayBuffer(dataBytes),
		mimeType,
		layers: [{ header: {} as never }],
		toBlob: () => new Blob(["x"], { type: mimeType }),
	};
}

function createAdapter() {
	return {
		exists: vi.fn().mockResolvedValue(false),
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
		remove: vi.fn().mockResolvedValue(undefined),
		getResourcePath: vi.fn((path: string) => `app://local/${path}`),
	};
}

describe("DecryptedCache", () => {
	let adapter: ReturnType<typeof createAdapter>;
	let createObjectURL: ReturnType<typeof vi.spyOn>;
	let revokeObjectURL: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		adapter = createAdapter();
		createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:mock");
		revokeObjectURL = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("dispose clears the pending sweep and revokes every blob URL", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => "cache",
		);
		await cache.getOrCreate(
			"cid-5",
			vi.fn().mockResolvedValue(decrypted(8)),
			1024,
			"cache",
		);
		await cache.getOrCreate(
			"cid-6",
			vi.fn().mockResolvedValue(decrypted(8)),
			1024,
			"cache",
		);
		adapter.exists.mockResolvedValue(true);
		adapter.list.mockResolvedValue({
			files: ["cache/cid-5.decrypted", "cache/cid-6.decrypted"],
			folders: [],
		});

		vi.useFakeTimers();
		cache.sweep(() => []);
		cache[Symbol.dispose]();
		expect(revokeObjectURL).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(31_000);
		expect(adapter.remove).not.toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledTimes(2);
	});

	it("sweeps stale disk files and blobs after 30 seconds, keeping active ones", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => "cache",
		);
		await cache.getOrCreate(
			"active",
			vi.fn().mockResolvedValue(decrypted(8)),
			1024,
			"cache",
		);
		await cache.getOrCreate(
			"stale",
			vi.fn().mockResolvedValue(decrypted(8)),
			1024,
			"cache",
		);
		adapter.exists.mockResolvedValue(true);
		adapter.list.mockResolvedValue({
			files: [
				"cache/active.decrypted",
				"cache/stale.decrypted",
				"cache/notes.txt",
			],
			folders: [],
		});

		vi.useFakeTimers();
		cache.sweep(() => ["active"]);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(adapter.remove).not.toHaveBeenCalled();
		expect(revokeObjectURL).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(adapter.remove).toHaveBeenCalledTimes(1);
		expect(adapter.remove).toHaveBeenCalledWith("cache/stale.decrypted");
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});

	it("reschedules the sweep when called again before the debounce elapses", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => "cache",
		);
		await cache.getOrCreate(
			"cid-4",
			vi.fn().mockResolvedValue(decrypted(8)),
			1024,
			"cache",
		);
		adapter.exists.mockResolvedValue(true);
		adapter.list.mockResolvedValue({
			files: ["cache/cid-4.decrypted"],
			folders: [],
		});

		vi.useFakeTimers();
		cache.sweep(() => ["active"]);
		await vi.advanceTimersByTimeAsync(20_000);
		cache.sweep(() => ["active"]);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(adapter.remove).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(adapter.remove).toHaveBeenCalledWith("cache/cid-4.decrypted");
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});

	it("throws a semantic error for large content when no cache dir is configured", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => undefined,
		);
		const provider = vi
			.fn()
			.mockResolvedValue(decrypted(2048, "application/pdf"));

		const error = await cache.getOrCreate("cid-3", provider, 1024, "").then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(DecryptedCacheDirMissingError);
		expect(error).toMatchObject({
			cid: "cid-3",
			mimeType: "application/pdf",
		});
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("writes large content to the cache dir and serves a disk hit without calling the provider", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => "cache",
		);
		const provider = vi.fn().mockResolvedValue(decrypted(2048));

		const first = await cache.getOrCreate("cid-2", provider, 1024, "cache");
		expect(first).toEqual({ kind: "disk", path: "cache/cid-2.decrypted" });
		expect(adapter.mkdir).toHaveBeenCalledWith("cache");
		expect(adapter.writeBinary).toHaveBeenCalledWith(
			"cache/cid-2.decrypted",
			expect.any(ArrayBuffer),
		);
		expect(createObjectURL).not.toHaveBeenCalled();

		adapter.exists.mockResolvedValue(true);
		const throwingProvider = vi
			.fn()
			.mockRejectedValue(new Error("must not decrypt on hit"));
		const second = await cache.getOrCreate(
			"cid-2",
			throwingProvider,
			1024,
			"cache",
		);
		expect(second).toEqual(first);
		expect(throwingProvider).not.toHaveBeenCalled();
	});

	it("creates one blob per CID and serves cache hits without calling the provider", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => undefined,
		);
		const provider = vi.fn().mockResolvedValue(decrypted(8));

		const first = await cache.getOrCreate("cid-1", provider, 1024, "cache");
		expect(first).toEqual({ kind: "blob", url: "blob:mock" });
		expect(createObjectURL).toHaveBeenCalledTimes(1);

		const throwingProvider = vi
			.fn()
			.mockRejectedValue(new Error("must not run"));
		const second = await cache.getOrCreate(
			"cid-1",
			throwingProvider,
			1024,
			"cache",
		);
		expect(second).toEqual(first);
		expect(throwingProvider).not.toHaveBeenCalled();
		expect(createObjectURL).toHaveBeenCalledTimes(1);
	});

	it("passes through undefined from the provider without creating a cache entry", async () => {
		const cache = new DecryptedCache(
			adapter as unknown as Adapter,
			() => undefined,
		);
		const provider = vi.fn().mockResolvedValue(undefined);

		const result = await cache.getOrCreate(
			"cid-1",
			provider,
			1024,
			"cache",
		);

		expect(result).toBeUndefined();
		expect(provider).toHaveBeenCalledTimes(1);
		expect(createObjectURL).not.toHaveBeenCalled();
		expect(adapter.writeBinary).not.toHaveBeenCalled();
	});
});

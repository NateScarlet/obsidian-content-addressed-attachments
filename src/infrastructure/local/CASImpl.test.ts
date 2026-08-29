import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import type { App, Vault, Stat } from "obsidian";
import { CASImpl } from "./CASImpl";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

// 内存文件系统：模拟 vault adapter 的少量文件操作，用于验证 CASImpl 的目录移动逻辑
class MemoryAdapter {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>([""]);

	normalize(p: string): string {
		return p.replace(/^\/+/, "");
	}

	exists(normalizedPath: string): Promise<boolean> {
		return Promise.resolve(this.files.has(this.normalize(normalizedPath)));
	}

	stat(normalizedPath: string): Promise<Stat | null> {
		const key = this.normalize(normalizedPath);
		const data = this.files.get(key);
		if (data !== undefined) {
			return Promise.resolve({
				type: "file",
				size: data.byteLength,
				mtime: Date.now(),
				ctime: Date.now(),
			});
		}
		if (this.dirs.has(key)) {
			return Promise.resolve({
				type: "folder",
				size: 0,
				mtime: Date.now(),
				ctime: Date.now(),
			});
		}
		return Promise.resolve(null);
	}

	async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		const key = this.normalize(normalizedPath);
		const data = this.files.get(key);
		if (!data) throw new Error(`file not found: ${normalizedPath}`);
		return data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength,
		) as ArrayBuffer;
	}

	async writeBinary(
		normalizedPath: string,
		data: ArrayBuffer,
	): Promise<void> {
		this.files.set(this.normalize(normalizedPath), new Uint8Array(data));
		this.ensureDirParents(normalizedPath);
	}

	private ensureDirParents(normalizedPath: string) {
		const parts = this.normalize(normalizedPath).split("/");
		let cur = "";
		for (const part of parts.slice(0, -1)) {
			cur = cur ? `${cur}/${part}` : part;
			this.dirs.add(cur);
		}
	}

	async remove(normalizedPath: string): Promise<void> {
		this.files.delete(this.normalize(normalizedPath));
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const key = this.normalize(oldPath);
		const data = this.files.get(key);
		if (!data) throw new Error(`rename source not found: ${oldPath}`);
		this.files.delete(key);
		this.files.set(this.normalize(newPath), data);
		this.ensureDirParents(newPath);
	}

	async list(normalizedPath: string): Promise<{
		files: string[];
		folders: string[];
	}> {
		const prefix = this.normalize(normalizedPath);
		const prefixWithSep = prefix ? prefix + "/" : "";
		const files: string[] = [];
		const folders = new Set<string>();
		for (const key of this.files.keys()) {
			if (prefixWithSep && !key.startsWith(prefixWithSep)) continue;
			const rest = key.slice(prefixWithSep.length);
			if (!rest) continue;
			const parts = rest.split("/");
			if (parts.length === 1) {
				files.push(prefix ? `${prefix}/${parts[0]}` : parts[0]);
			} else {
				folders.add(prefix ? `${prefix}/${parts[0]}` : parts[0]);
			}
		}
		for (const d of this.dirs) {
			if (prefixWithSep && !d.startsWith(prefixWithSep)) continue;
			const rest = d.slice(prefixWithSep.length);
			if (!rest || rest.includes("/")) continue;
			folders.add(prefix ? `${prefix}/${rest}` : rest);
		}
		return { files, folders: [...folders] };
	}
}

/** 简单内存元数据实现，便于测试 CASImpl 的目录移动 */
class MemoryMetadata implements CASMetadata {
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

	async *find(options: {
		signal: AbortSignal | undefined;
		filterBy?: {
			cid?: CID[];
			query?: string;
			hasReference?: boolean;
			isTrashed?: boolean;
		};
		after?: string;
	}): AsyncIterableIterator<{ node: CASMetadataObject; cursor: string }> {
		for (const obj of this.map.values()) {
			if (options.filterBy?.isTrashed === true && !obj.trashedAt)
				continue;
			if (options.filterBy?.isTrashed === false && obj.trashedAt)
				continue;
			yield { node: obj, cursor: obj.cid.toString() };
		}
	}

	async estimateStorage() {
		return { normalBytes: 0, trashBytes: 0 };
	}
}

// 构造固定 CID 和对应的 CAS 分片相对路径
async function makeCID(data: string): Promise<{ cid: CID; relPath: string }> {
	const bytes = new TextEncoder().encode(data);
	const hash = await sha256.digest(bytes);
	const cid = CID.create(1, raw.code, hash);
	const h = cid.toString(base32upper).slice(1);
	const shard = h.slice(h.length - 3, h.length - 1);
	return { cid, relPath: `${shard}/${h}.data` };
}

describe("CASImpl 目录移动逻辑（用户场景：文件位于网关下载目录 .wharvest/download）", () => {
	let adapter: MemoryAdapter;
	let meta: MemoryMetadata;
	let cas: CASImpl;
	let app: App;

	// 用户实际配置：primaryDir 主存储、downloadDir 全局下载、web harvest 网关 downloadDir
	const primaryDir = ".attachments/cas";
	const downloadDir = ".attachments/download";
	const wharvestDir = ".wharvest/download";

	beforeEach(() => {
		adapter = new MemoryAdapter();
		meta = new MemoryMetadata();
		app = {
			vault: {
				adapter: adapter as never,
				createFolder: vi.fn(async (path: string) => {
					adapter.dirs.add(path);
				}),
				getFolderByPath: vi.fn((path: string) =>
					adapter.dirs.has(path) ? ({ path } as never) : null,
				),
			},
		} as unknown as App;
		cas = new CASImpl(app, meta, () => [
			primaryDir,
			downloadDir,
			wharvestDir,
		]);
	});

	it("对象扫描时不会把网关下载目录中的文件移动到主存储", async () => {
		const { cid, relPath } = await makeCID("wharvest-image-content");
		// web harvest 软件直接写入 .wharvest/download 的文件
		await adapter.writeBinary(
			`${wharvestDir}/${relPath}`,
			new TextEncoder().encode("wharvest-image-content"),
		);

		// 触发全量索引扫描
		for await (const obj of cas.objects()) {
			await cas.index(obj);
		}

		// 文件仍应位于 .wharvest/download，不应被移动到主存储
		expect(await adapter.exists(`${wharvestDir}/${relPath}`)).toBe(true);
		expect(await adapter.exists(`${primaryDir}/${relPath}`)).toBe(false);
		expect(await adapter.exists(`${downloadDir}/${relPath}`)).toBe(false);
	});

	it("load 网关下载目录中的文件时不会移动它", async () => {
		const { cid, relPath } = await makeCID("wharvest-image-content");
		await adapter.writeBinary(
			`${wharvestDir}/${relPath}`,
			new TextEncoder().encode("wharvest-image-content"),
		);

		const result = await cas.load(cid);

		expect(result?.normalizedPath).toBe(`${wharvestDir}/${relPath}`);
		expect(await adapter.exists(`${wharvestDir}/${relPath}`)).toBe(true);
		expect(await adapter.exists(`${primaryDir}/${relPath}`)).toBe(false);
	});

	it("从网关下载目录的 .trash 恢复时恢复到该目录而不是主存储", async () => {
		const { cid, relPath } = await makeCID("wharvest-image-content");
		await adapter.writeBinary(
			`${wharvestDir}/.trash/${relPath}`,
			new TextEncoder().encode("wharvest-image-content"),
		);
		await meta.merge({
			cid,
			indexedAt: new Date(),
			trashedAt: new Date(),
		});

		const didRestore = await cas.restoreIfTrashed(cid);

		expect(didRestore).toBe(true);
		// 恢复目标应为 .wharvest/download（.trash 所在目录），而不是主存储
		expect(await adapter.exists(`${wharvestDir}/${relPath}`)).toBe(true);
		expect(await adapter.exists(`${primaryDir}/${relPath}`)).toBe(false);
		expect(await adapter.exists(`${wharvestDir}/.trash/${relPath}`)).toBe(
			false,
		);
	});
});

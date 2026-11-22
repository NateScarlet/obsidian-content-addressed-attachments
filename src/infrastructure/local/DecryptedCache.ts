import type { App } from "obsidian";
import type { DecryptedResult } from "#src/lib/encryption/EncryptionService";

type VaultAdapter = App["vault"]["adapter"];

/** 解密缓存命中的资源形态：内存 blob URL 或磁盘上的明文文件 */
export type DecryptedCacheResource =
	| { kind: "blob"; url: string }
	| { kind: "disk"; path: string };

/** 内容需要落盘，但未配置解密缓存目录 */
export class DecryptedCacheDirMissingError extends Error {
	constructor(
		readonly cid: string,
		readonly mimeType: string,
		readonly size: number,
	) {
		super(`Decrypted cache directory is not set for ${cid}`);
		this.name = "DecryptedCacheDirMissingError";
	}
}

/**
 * # 解密缓存（本地文件存储层）
 *
 * 以内容 CID 为唯一键，统一维护内存 blob URL 与磁盘明文副本。`getOrCreate` 在缓存命中时
 * 不调用明文提供者，从而保留「密钥已清除但缓存仍在时仍可显示」的既有行为；`sweep` 自持
 * 防抖定时器与活跃 CID 匹配策略，调用方只提供活跃的 CID 来源与缓存目录读取器。
 */
export default class DecryptedCache {
	private blobStore = new Map<string, string>();
	private cleanupTimer: number | undefined;

	constructor(
		private adapter: VaultAdapter,
		// sweep 在防抖触发时才读取目录：既能反映期间的设置变更，也能清理上次运行
		// 遗留的明文文件；getOrCreate 的目录参数则由调用方按当前配置传入
		private getCacheDir: () => string | undefined,
	) {}

	async getOrCreate(
		cid: string,
		provider: () => Promise<DecryptedResult | undefined>,
		maxBlob: number,
		cacheDir: string | undefined,
	): Promise<DecryptedCacheResource | undefined> {
		const hit = this.blobStore.get(cid);
		if (hit) return { kind: "blob", url: hit };

		const cachePath = cacheDir ? `${cacheDir}/${cid}.decrypted` : undefined;
		if (cachePath && (await this.adapter.exists(cachePath))) {
			return { kind: "disk", path: cachePath };
		}

		const decrypted = await provider();
		// 提供者以 undefined 表达「未加密 / 合法缺失」，module 原样透传，不引入加密层概念
		if (!decrypted) return undefined;

		if (decrypted.data.byteLength <= maxBlob) {
			const url = URL.createObjectURL(decrypted.toBlob());
			this.blobStore.set(cid, url);
			return { kind: "blob", url };
		}
		if (!cacheDir || !cachePath) {
			throw new DecryptedCacheDirMissingError(
				cid,
				decrypted.mimeType,
				decrypted.data.byteLength,
			);
		}
		if (!(await this.adapter.exists(cacheDir))) {
			await this.adapter.mkdir(cacheDir);
		}
		await this.adapter.writeBinary(cachePath, decrypted.data);
		return { kind: "disk", path: cachePath };
	}

	sweep(getActiveCids: () => Iterable<string> | AsyncIterable<string>): void {
		if (this.cleanupTimer !== undefined) {
			window.clearTimeout(this.cleanupTimer);
		}
		this.cleanupTimer = window.setTimeout(() => {
			void (async () => {
				this.cleanupTimer = undefined;
				await this.sweepNow(getActiveCids);
			})();
		}, 30_000);
	}

	/** 扫描磁盘与内存缓存，删除/撤销不再被活跃 CID 引用的条目。 */
	private async sweepNow(
		getActiveCids: () => Iterable<string> | AsyncIterable<string>,
	): Promise<void> {
		const cacheDir = this.getCacheDir();
		if (this.blobStore.size === 0 && !cacheDir) return;

		if (cacheDir) {
			try {
				if (await this.adapter.exists(cacheDir)) {
					const files = await this.adapter.list(cacheDir);
					for (const filePath of files.files) {
						const fileName = filePath.split("/").pop() ?? "";
						if (!fileName.endsWith(".decrypted")) continue;
						const cid = fileName.slice(0, -".decrypted".length);
						// 惰性查找：命中即中断生成器，避免为每个文件都全量收集活跃 CID
						let isActive = false;
						for await (const activeCid of getActiveCids()) {
							if (activeCid === cid) {
								isActive = true;
								break;
							}
						}
						if (!isActive) {
							try {
								await this.adapter.remove(filePath);
							} catch (err) {
								console.error(
									`Failed to cleanup decrypted cache for CID ${cid}:`,
									err,
								);
							}
						}
					}
				}
			} catch (err) {
				console.error("Failed to list decrypted cache directory:", err);
			}
		}

		const activeCids = new Set<string>();
		for await (const cid of getActiveCids()) {
			activeCids.add(cid);
		}
		for (const [cid, url] of this.blobStore) {
			if (!activeCids.has(cid)) {
				URL.revokeObjectURL(url);
				this.blobStore.delete(cid);
			}
		}
	}

	[Symbol.dispose](): void {
		if (this.cleanupTimer !== undefined) {
			window.clearTimeout(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}
		for (const url of this.blobStore.values()) {
			URL.revokeObjectURL(url);
		}
		this.blobStore.clear();
	}
}

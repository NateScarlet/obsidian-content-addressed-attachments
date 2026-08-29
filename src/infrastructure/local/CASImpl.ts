import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { App, getBlobArrayBuffer } from "obsidian";
import makeDirs from "#src/utils/makeDirs";
import { mergeCopies } from "#src/utils/casCopies";
import { basename, dirname, join } from "path-browserify";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "#src/types/CASMetadata";

export class CASImpl implements CAS {
	private trashRelPath = ".trash";

	constructor(
		private app: App,
		private meta: CASMetadata,
		private dirs: () => Iterable<string>,
	) {}

	async *lookup(cid: CID) {
		const relPath = this.formatRelPath(cid);
		for (const dir of this.dirs()) {
			const path = this.getFilePath(dir, relPath);
			let stat = await this.app.vault.adapter.stat(path);
			if (stat) {
				yield {
					dir,
					path,
					stat,
					isTrashed: false,
				};
			}
			const trashPath = this.getTrashPath(dir, relPath);
			stat = await this.app.vault.adapter.stat(trashPath);
			if (stat) {
				yield {
					dir,
					path: trashPath,
					stat,
					isTrashed: true,
				};
			}
		}
	}

	async index(meta: CASMetadataObject): Promise<void> {
		const existing = await this.meta.get(meta.cid);
		if (existing) {
			// 已有记录：保留副本状态，不扫描磁盘，避免因存在正常副本而误清回收站状态
			await this.meta.merge({
				...meta,
				copies: existing.copies,
			});
			return;
		}
		// 首次登记：扫描一次初始化副本状态（含回收站副本，供后续自动恢复判断）
		const copies = await this.collectCopies(meta.cid);
		if (copies.length === 0) {
			// 磁盘上没有任何副本，不登记
			return;
		}
		await this.meta.merge({ ...meta, copies });
	}

	/** 收集某 CID 在所有目录的副本状态（含回收站副本） */
	private async collectCopies(
		cid: CID,
	): Promise<{ dir: string; trashedAt?: Date }[]> {
		const copies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			copies.push({
				dir: match.dir,
				trashedAt: match.isTrashed
					? new Date(match.stat.mtime)
					: undefined,
			});
		}
		return mergeCopies(undefined, copies);
	}

	async deleteIfTrashed(cid: CID): Promise<number> {
		let count = 0;
		const remainingCopies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			if (match.isTrashed) {
				await this.app.vault.adapter.remove(match.path);
				count += 1;
			} else {
				remainingCopies.push({ dir: match.dir, trashedAt: undefined });
			}
		}
		if (remainingCopies.length > 0) {
			// 仍有正常副本：更新副本状态，仅保留正常副本
			const existing = await this.meta.get(cid);
			await this.meta.merge({
				...(existing ?? { cid, indexedAt: new Date() }),
				copies: remainingCopies,
			});
		} else {
			// 副本全部被清空或文件不存在，确保元数据和实际一致
			await this.meta.delete(cid);
		}
		return count;
	}

	async *objects(): AsyncIterableIterator<CASMetadataObject> {
		// 同一 CID 可能同时存在于多个目录（正常或回收站），按 CID 聚合为单条记录
		const byCid = new Map<string, CASMetadataObject>();
		const add = (obj: CASMetadataObject) => {
			const key = obj.cid.toString();
			const existing = byCid.get(key);
			if (existing) {
				existing.copies = mergeCopies(
					existing.copies,
					obj.copies ?? [],
				);
			} else {
				byCid.set(key, obj);
			}
		};
		for (const dir of this.dirs()) {
			// 扫描正常文件
			for await (const obj of this.scanBaseDir(dir, dir, false)) {
				add(obj);
			}

			// 扫描回收站文件
			const trashDir = join(dir, this.trashRelPath);
			if (await this.app.vault.adapter.exists(trashDir)) {
				for await (const obj of this.scanBaseDir(trashDir, dir, true)) {
					add(obj);
				}
			}
		}
		yield* byCid.values();
	}

	private async *scanBaseDir(
		baseDir: string,
		dir: string,
		trashed: boolean,
	): AsyncIterableIterator<CASMetadataObject> {
		// 列出 baseDir 下的所有项目
		const items = await this.app.vault.adapter.list(baseDir);

		// 只处理符合分片目录格式的文件夹（2个字符的目录名）
		for (const folder of items.folders) {
			// 递归扫描分片目录下的文件
			yield* this.scanShardDir(folder, dir, trashed);
		}
	}

	private async *scanShardDir(
		shardDir: string,
		dir: string,
		trashed: boolean,
	): AsyncIterableIterator<CASMetadataObject> {
		const shard = basename(shardDir);

		// 检查是否是分片目录：必须是2个字符
		if (shard.length !== 2) {
			return;
		}

		const items = await this.app.vault.adapter.list(shardDir);

		for (const filePath of items.files) {
			const metadata = await this.metadataFromPath(
				shard,
				dir,
				filePath,
				trashed,
			);
			if (metadata) {
				yield metadata;
			}
		}
	}

	private async metadataFromPath(
		shard: string,
		dir: string,
		normalizedPath: string,
		trashed: boolean,
	): Promise<CASMetadataObject | undefined> {
		const base = basename(normalizedPath);
		const { vault } = this.app;
		// CID Base32 编码长度为 59
		if (base.length === 59 - 1 + 5 && base.endsWith(".data")) {
			if (base.slice(-8, -6) !== shard) {
				console.warn("忽略不匹配分片目录的文件", normalizedPath);
				return;
			}
			// 如果有错误格式的CID，说明有外部使用了不兼容的哈希函数，不应静默忽略
			try {
				const cid = CID.parse("B" + base.slice(0, 58), base32upper);
				const stat = await vault.adapter.stat(normalizedPath);
				if (stat?.type !== "file") {
					return;
				}
				return {
					cid,
					indexedAt: new Date(),
					size: stat.size,
					copies: [
						{
							dir,
							trashedAt: trashed
								? new Date(stat.mtime)
								: undefined,
						},
					],
				};
			} catch (err) {
				throw new Error(
					`go invalid file in cas: ${normalizedPath}: ${String(err)}`,
				);
			}
		}
	}

	formatNormalizePath(dir: string, cid: CID): string {
		return join(dir, this.formatRelPath(cid));
	}

	async restoreIfTrashed(cid: CID): Promise<boolean> {
		let didRestore = false;
		const copies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			if (match.isTrashed) {
				// 界面按 CID 粒度操作，恢复所有目录的回收站副本
				const src = match.path;
				const relPath = this.formatRelPath(cid);
				const dst = this.getFilePath(match.dir, relPath);

				await makeDirs(this.app.vault, dirname(dst));
				// 目标目录可能已存在同 CID 正常副本，冲突时按 moveReplacingFile 去重/坏标
				await this.moveReplacingFile(src, dst, cid);
				didRestore = true;
			}
			// 该 CID 在所有目录的副本都恢复为正常状态
			copies.push({ dir: match.dir, trashedAt: undefined });
		}
		if (copies.length > 0) {
			const existing = await this.meta.get(cid);
			await this.meta.merge({
				...(existing ?? { cid, indexedAt: new Date() }),
				copies: mergeCopies(undefined, copies),
				size: existing?.size,
			});
		}
		return didRestore;
	}

	async load(
		cid: CID,
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined> {
		let didRestore = false;
		let firstNormalPath: string | undefined;
		const copies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			if (match.isTrashed) {
				// 尝试从回收站恢复（所有副本统一操作）
				const src = match.path;
				const relPath = this.formatRelPath(cid);
				const dst = this.getFilePath(match.dir, relPath);
				const content = await this.app.vault.adapter.readBinary(src);
				if (!cid.equals(await this.generateCID(content))) {
					// 检查文件完整性
					console.warn("发现损坏文件，标记为无效", src);
					await this.app.vault.adapter.rename(
						src,
						this.formatInvalidName(src),
					);
					continue;
				}

				await makeDirs(this.app.vault, dirname(dst));
				await this.app.vault.adapter.rename(src, dst);
				copies.push({ dir: match.dir, trashedAt: undefined });
				firstNormalPath ??= dst;
				didRestore = true;
			} else {
				copies.push({ dir: match.dir, trashedAt: undefined });
				firstNormalPath ??= match.path;
			}
		}
		if (copies.length === 0) {
			await this.meta.delete(cid);
			return undefined;
		}
		const existing = await this.meta.get(cid);
		await this.meta.merge({
			...(existing ?? { cid, indexedAt: new Date() }),
			copies: mergeCopies(undefined, copies),
			size: existing?.size,
		});
		return {
			normalizedPath: firstNormalPath!,
			didRestore,
		};
	}

	async trash(cid: CID): Promise<number> {
		const relPath = this.formatRelPath(cid);
		let count = 0;
		let exists = false;
		const copies: { dir: string; trashedAt?: Date }[] = [];
		const now = new Date();
		for await (const match of this.lookup(cid)) {
			exists = true;
			if (match.isTrashed) {
				// 已在回收站：保持回收状态（时间取文件修改时间）
				copies.push({
					dir: match.dir,
					trashedAt: new Date(match.stat.mtime),
				});
				continue;
			}
			const src = match.path;
			const dst = this.getTrashPath(match.dir, relPath);
			await makeDirs(this.app.vault, dirname(dst));
			await this.moveReplacingFile(src, dst, cid);
			copies.push({ dir: match.dir, trashedAt: now });
			count += 1;
		}
		if (copies.length > 0) {
			// 更新元数据：重建该 CID 的副本状态（所有目录都标记为已回收）
			const existingMeta = await this.meta.get(cid);
			await this.meta.merge({
				...(existingMeta ?? { cid, indexedAt: new Date() }),
				copies: mergeCopies(undefined, copies),
			});
		}
		if (!exists) {
			// 文件不存在，确保元数据和实际一致
			await this.meta.delete(cid);
		}
		return count;
	}

	async save(
		dir: string,
		file: File,
	): Promise<{ cid: CID; didCreate: boolean }> {
		const arrayBuffer = await getBlobArrayBuffer(file);
		const cid = await this.generateCID(arrayBuffer);
		const relPath = this.formatRelPath(cid);
		const filePath = this.getFilePath(dir, relPath);
		const exists = await this.app.vault.adapter.exists(filePath);

		if (exists) {
			console.debug("save", {
				filename: file.name,
				filePath,
				didCreate: false,
			});
			return { cid, didCreate: false };
		}

		await makeDirs(this.app.vault, dirname(filePath));
		await this.app.vault.adapter.writeBinary(filePath, arrayBuffer);

		// 更新元数据：本目录新增正常副本，其他目录的副本状态（含回收站）保留，不扫描磁盘
		const existing = await this.meta.get(cid);
		await this.meta.merge({
			cid,
			indexedAt: new Date(),
			filename: file.name,
			format: file.type,
			size: file.size,
			copies: mergeCopies(existing?.copies, [
				{ dir, trashedAt: undefined },
			]),
		});

		console.debug("save", {
			filename: file.name,
			filePath,
			didCreate: true,
		});
		return { cid, didCreate: true };
	}

	formatRelPath(cid: CID): string {
		// 解析 CID

		const h = cid.toString(base32upper).slice(1); // 第一个字母固定是 B 所以忽略

		// 使用倒数第三和第二个字符进行分片
		if (h.length < 4) {
			throw new Error(`unexpected short CID: '${cid.toString()}'`);
		}
		const shard = h.slice(h.length - 3, h.length - 1);
		return `${shard}/${h}.data`;
	}

	private async generateCID(content: ArrayBuffer): Promise<CID> {
		// 将 ArrayBuffer 转换为 Uint8Array
		const bytes = new Uint8Array(content);

		// 使用 SHA-256 哈希和 raw 编解码器创建 CIDv1
		const hash = await sha256.digest(bytes);
		const cid = CID.create(1, raw.code, hash);

		return cid;
	}

	private getFilePath(dir: string, relPath: string): string {
		return join(dir, relPath);
	}

	private getTrashPath(dir: string, relPath: string): string {
		return join(dir, this.trashRelPath, relPath);
	}

	/**
	 * 把 src 移动到 dst（trash 移入、restore 移出都用）。
	 * 目标已存在：同内容则删除多余源（多目录去重）；目标损坏则标记无效后再移动。
	 */
	private async moveReplacingFile(src: string, dst: string, cid: CID) {
		try {
			await this.app.vault.adapter.rename(src, dst);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message === "Destination file already exists!"
			) {
				const content = await this.app.vault.adapter.readBinary(dst);
				if (!cid.equals(await this.generateCID(content))) {
					console.warn("发现损坏文件，标记为无效", dst);
					await this.app.vault.adapter.rename(
						dst,
						this.formatInvalidName(dst),
					);
					await this.app.vault.adapter.rename(src, dst);
				} else {
					// 目标已是同一内容的完整副本，删除多余源即可
					await this.app.vault.adapter.remove(src);
				}
			} else {
				throw err;
			}
		}
	}

	private formatInvalidName(src: string): string {
		return `${src}~${Date.now()}.invalid`;
	}
}

import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { App, getBlobArrayBuffer } from "obsidian";
import makeDirs from "src/utils/makeDirs";
import { basename, dirname, join } from "path-browserify";
import type { CAS } from "src/types/CAS";
import type { CASMetadata, CASMetadataObject } from "src/types/CASMetadata";

export class CASImpl implements CAS {
	private trashRelPath = ".trash";

	constructor(
		private app: App,
		private meta: CASMetadata,
		private rootDir: () => string,
	) {}

	async delete(cid: CID): Promise<void> {
		const filePath = this.getFilePath(cid);

		// 检查文件是否存在
		if (await this.app.vault.adapter.exists(filePath)) {
			await this.app.vault.adapter.remove(filePath);
		}

		// 从元数据中删除
		await this.meta.delete(cid);
	}

	async *objects(): AsyncIterableIterator<CASMetadataObject> {
		const root = this.rootDir();

		// 扫描正常文件
		yield* this.scanBaseDir(root, false);

		// 扫描回收站文件
		const trashDir = join(root, this.trashRelPath);
		if (await this.app.vault.adapter.exists(trashDir)) {
			yield* this.scanBaseDir(trashDir, true);
		}
	}

	private async *scanBaseDir(
		baseDir: string,
		trashed: boolean,
	): AsyncIterableIterator<CASMetadataObject> {
		// 列出 baseDir 下的所有项目
		const items = await this.app.vault.adapter.list(baseDir);

		// 只处理符合分片目录格式的文件夹（2个字符的目录名）
		for (const folder of items.folders) {
			const folderName = basename(folder);

			// 检查是否是分片目录：必须是2个字符
			if (folderName.length !== 2) {
				continue;
			}

			// 递归扫描分片目录下的文件
			yield* this.scanShardDir(folder, trashed);
		}
	}

	private async *scanShardDir(
		shardDir: string,
		trashed: boolean,
	): AsyncIterableIterator<CASMetadataObject> {
		const items = await this.app.vault.adapter.list(shardDir);

		for (const filePath of items.files) {
			const metadata = await this.metadataFromPath(filePath, trashed);
			if (metadata) {
				yield metadata;
			}
		}
	}

	private async metadataFromPath(
		normalizedPath: string,
		trashed: boolean,
	): Promise<CASMetadataObject | undefined> {
		const base = basename(normalizedPath);
		const { vault } = this.app;
		// CID Base32 编码长度为 59
		if (base.length === 59 - 1 + 5 && base.endsWith(".data")) {
			// 如果有错误格式的CID，说明有其他程序用了不兼容的哈希函数，不应静默忽略
			try {
				const cid = CID.parse("B" + base.slice(0, 58), base32upper);
				const stat = await vault.adapter.stat(normalizedPath);
				if (stat?.type !== "file") {
					return;
				}
				return {
					cid,
					indexedAt: new Date(),
					trashedAt: trashed ? new Date(stat.mtime) : undefined,
					size: stat.size,
				};
			} catch (err) {
				throw new Error(
					`go invalid file in cas: ${normalizedPath}: ${err}`,
				);
			}
		}
	}

	formatNormalizePath(cid: CID): string {
		return join(this.rootDir(), this.formatRelPath(cid));
	}

	async load(
		cid: CID,
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined> {
		const root = this.rootDir();
		const relPath = this.formatRelPath(cid);
		const dst = join(root, relPath);

		if (await this.app.vault.adapter.exists(dst)) {
			return {
				normalizedPath: dst,
				didRestore: false,
			};
		}

		// 尝试从回收站恢复
		const src = join(root, this.trashRelPath, relPath);
		if (await this.app.vault.adapter.exists(src)) {
			const content = await this.app.vault.adapter.readBinary(src);
			if (!cid.equals(await this.generateCID(content))) {
				// 检查文件完整性
				console.warn("发现损坏文件，标记为无效", src);
				await this.app.vault.adapter.rename(
					src,
					this.formatInvalidName(src),
				);
				return;
			}

			await makeDirs(this.app.vault, dirname(dst));
			await this.app.vault.adapter.rename(src, dst);

			// 更新元数据
			const existingMeta = await this.meta.get(cid);
			await this.meta.save({
				...existingMeta,
				trashedAt: undefined,
				cid: cid,
				indexedAt: new Date(),
			});

			return {
				normalizedPath: dst,
				didRestore: true,
			};
		}
	}

	async trash(cid: CID, invalid?: boolean): Promise<boolean> {
		const root = this.rootDir();
		const relPath = this.formatRelPath(cid);
		const src = join(root, relPath);

		if (!(await this.app.vault.adapter.exists(src))) {
			return false;
		}

		let dst = join(root, this.trashRelPath, relPath);
		if (invalid) {
			dst = this.formatInvalidName(dst);
		} else if (await this.app.vault.adapter.exists(dst)) {
			await this.app.vault.adapter.remove(dst);
		}

		await makeDirs(this.app.vault, dirname(dst));
		await this.app.vault.adapter.rename(src, dst);

		// 更新元数据：标记为已删除
		const existingMeta = await this.meta.get(cid);
		if (existingMeta) {
			const updatedMeta = { ...existingMeta, trashedAt: new Date() };
			await this.meta.save(updatedMeta);
		} else {
			// 如果元数据不存在，创建新的元数据记录
			const newMeta: CASMetadataObject = {
				cid,
				indexedAt: new Date(),
				trashedAt: new Date(),
			};
			await this.meta.save(newMeta);
		}

		return true;
	}

	async save(file: File): Promise<{ cid: CID; didCreate: boolean }> {
		const arrayBuffer = await getBlobArrayBuffer(file);
		const cid = await this.generateCID(arrayBuffer);
		const filePath = this.getFilePath(cid);
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

		await this.meta.save({
			cid,
			indexedAt: new Date(),
			filename: file.name,
			format: file.type,
			size: file.size,
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

	private getFilePath(cid: CID): string {
		const relativePath = this.formatRelPath(cid);
		return `${this.rootDir()}/${relativePath}`;
	}

	private formatInvalidName(src: string): string {
		return `${src}~${Date.now()}.invalid`;
	}
}

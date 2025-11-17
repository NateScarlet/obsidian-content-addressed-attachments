import type { CAS } from "./main";
import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { App, getBlobArrayBuffer } from "obsidian";
import makeDirs from "./utils/makeDirs";
import { dirname, join } from "path-browserify";

export class LocalCAS implements CAS {
	private static trashRelPath = ".trash";

	constructor(
		private app: App,
		private rootDir: () => string,
	) {}

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
		const src = join(root, LocalCAS.trashRelPath, relPath);
		if (await this.app.vault.adapter.exists(src)) {
			const content = await this.app.vault.adapter.readBinary(src);
			if (!cid.equals(this.generateCID(content))) {
				// 检查文件完整性
				console.warn("发现损坏文件，标记为无效", src);
				await this.app.vault.adapter.rename(
					src,
					this.formatInvalidName(src),
				);
				return;
			}
			await this.app.vault.adapter.rename(src, dst);
			return {
				normalizedPath: dst,
				didRestore: true,
			};
		}
	}

	async trash(cid: CID, invalid?: boolean): Promise<void> {
		const root = this.rootDir();
		const relPath = this.formatRelPath(cid);
		const src = join(root, relPath);
		if (!(await this.app.vault.adapter.exists(src))) {
			return;
		}
		let dst = join(root, LocalCAS.trashRelPath, relPath);
		if (invalid) {
			dst = this.formatInvalidName(dst);
		} else if (await this.app.vault.adapter.exists(dst)) {
			await this.app.vault.adapter.remove(dst);
		}
		return await this.app.vault.adapter.rename(src, dst);
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

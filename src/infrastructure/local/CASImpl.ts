import { CID } from "multiformats/cid";
import { base32upper } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { App, getBlobArrayBuffer } from "obsidian";
import makeDirs from "#src/utils/makeDirs";
import { mergeCopies } from "#src/utils/casCopies";
import { basename, dirname, join } from "path-browserify";
import { shuffle } from "es-toolkit";
import orderedParallelMap, {
	DEFAULT_PARALLEL_LIMIT,
} from "#src/utils/orderedParallelMap";
import type { CAS, CASDirCopy, CASWriteGuard } from "#src/types/CAS";
import type {
	CASMetadata,
	CASMetadataCopy,
	CASMetadataObject,
} from "#src/types/CASMetadata";
import type { CASMetadataSync } from "#src/types/CASMetadataSync";

export class CASImpl implements CAS {
	private trashRelPath = ".trash";

	constructor(
		private app: App,
		private meta: CASMetadata,
		private dirs: () => Iterable<string>,
		private sync: CASMetadataSync,
		private guard: CASWriteGuard,
	) {}

	// #region 副本探测

	async *lookup(cid: CID) {
		// 公开契约为「该 CID 在所有目录的全部副本」，不传 dirs 即全部目录
		yield* this.probeCopies(cid);
	}

	/**
	 * 探测某 CID 在给定目录中的副本（每个目录的正常路径与回收站路径）。
	 * 不传 dirs 即探测全部目录；调用方可只传部分目录，借此跳过已知不含该 CID 的目录。
	 * cache 用于跨调用复用「该目录有无回收站」的判断；skip 排除已从别处取得 stat
	 * 的那个副本，避免重复探测。
	 */
	private async *probeCopies(
		cid: CID,
		dirs: string[] = [...this.dirs()],
		cache: TrashDirCache = new TrashDirCache(),
		skip?: { dir: string; trashed: boolean },
	) {
		const relPath = this.formatRelPath(cid);
		for (const dir of dirs) {
			for (const trashed of [false, true]) {
				if (skip?.dir === dir && skip.trashed === trashed) {
					continue;
				}
				if (trashed && !(await this.hasTrashDir(dir, cache))) {
					continue;
				}
				const found = await this.statCopy(dir, relPath, trashed);
				if (found) {
					yield found;
				}
			}
		}
	}

	/** 探测单个副本路径；文件不存在时返回 undefined */
	private async statCopy(dir: string, relPath: string, trashed: boolean) {
		const path = trashed
			? this.getTrashPath(dir, relPath)
			: this.getFilePath(dir, relPath);
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type !== "file") {
			return undefined;
		}
		return { dir, path, stat, isTrashed: trashed };
	}

	/** 目录是否已有回收站；结果按目录缓存，一次扫描内复用 */
	private hasTrashDir(dir: string, cache: TrashDirCache) {
		return cache.get(dir, () =>
			this.app.vault.adapter.exists(join(dir, this.trashRelPath)),
		);
	}

	// #endregion

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

	/**
	 * 收集某 CID 在所有目录的副本状态（含回收站副本）。
	 * 公开供后台索引追平（写侧同步消费者）按磁盘真相重建副本状态使用。
	 */
	async collectCopies(
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

	async removeCopyInDir(cid: CID, dir: string): Promise<boolean> {
		const path = this.getFilePath(dir, this.formatRelPath(cid));
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type !== "file") {
			return false;
		}
		await this.app.vault.adapter.remove(path);
		// 落盘事实已变，仅发布失效信号：副本状态由后台索引按磁盘真相对账
		// （其它目录仍有副本时合并，副本删净时删除记录），本方法不读写元数据。
		this.sync.notifyChanged({ cid });
		return true;
	}

	/**
	 * 直接遍历单个目录的正常副本：不查元数据库、不探测其它目录与回收站。
	 * 供下载目录清理按保留期删除副本使用——目录里有多少文件就做多少次 stat，
	 * 与元数据表的规模无关。
	 */
	async *walkDirCopies(dir: string): AsyncIterableIterator<CASDirCopy> {
		// 分片目录与分片内的文件都是随机顺序：清理只关心删不删、不关心先后，
		// 随机化可避免单个报错文件在多次清理中反复卡住同一批副本
		for (const shardDir of shuffle(await this.listShardDirs(dir))) {
			const { files } = await this.app.vault.adapter.list(shardDir);
			yield* this.statShardCopies(basename(shardDir), shuffle(files));
		}
	}

	async *objects(): AsyncIterableIterator<CASMetadataObject> {
		const dirs = [...this.dirs()];
		// 已产出的 CID：其全部副本都在首次出现时查清，后续目录遇到直接跳过
		const processed = new Set<string>();
		const cache = new TrashDirCache();

		for (const [dirIndex, dir] of dirs.entries()) {
			// 先正常区，再回收站；回收站不存在时整段跳过
			const areas = [
				{ baseDir: dir, trashed: false },
				{ baseDir: join(dir, this.trashRelPath), trashed: true },
			];
			for (const { baseDir, trashed } of areas) {
				if (trashed && !(await this.hasTrashDir(dir, cache))) {
					continue;
				}
				for await (const found of this.scanBaseDir(
					baseDir,
					dir,
					trashed,
				)) {
					const key = found.cid.toString();
					if (processed.has(key)) {
						continue;
					}
					processed.add(key);
					yield await this.completeObject(
						found,
						dirs,
						dirIndex,
						trashed,
						cache,
					);
				}
			}
		}
	}

	/**
	 * 把「首次发现的单个副本」补成该 CID 的完整副本集合。
	 * 只在尚未扫描的目录中探测，不回查已扫描过的目录：
	 * - 正常区首见：本目录正常路径即命中项，只需补本目录回收站与后续目录；
	 * - 回收站首见：本目录正常区已扫完且此前未产出该 CID（否则已被跳过），
	 *   故自下一个目录开始补。
	 */
	private async completeObject(
		found: CASMetadataObject,
		dirs: string[],
		dirIndex: number,
		trashed: boolean,
		cache: TrashDirCache,
	): Promise<CASMetadataObject> {
		// 命中项已带本目录该副本的 stat，其余未扫描目录需探测
		const probeDirs = trashed
			? dirs.slice(dirIndex + 1)
			: dirs.slice(dirIndex);
		// 回收站首见时整个当前目录已排除，无需再指定要跳过的副本
		const skip = trashed
			? undefined
			: { dir: dirs[dirIndex], trashed: false };
		const copies: CASMetadataCopy[] = [...(found.copies ?? [])];
		for await (const probe of this.probeCopies(
			found.cid,
			probeDirs,
			cache,
			skip,
		)) {
			copies.push({
				dir: probe.dir,
				trashedAt: probe.isTrashed
					? new Date(probe.stat.mtime)
					: undefined,
			});
		}
		return { ...found, copies: mergeCopies(undefined, copies) };
	}

	private async *scanBaseDir(
		baseDir: string,
		dir: string,
		trashed: boolean,
	): AsyncIterableIterator<CASMetadataObject> {
		// 只处理符合分片目录格式的文件夹（2个字符的目录名）
		for (const shardDir of await this.listShardDirs(baseDir)) {
			const { files } = await this.app.vault.adapter.list(shardDir);
			// 递归扫描分片目录下的文件；重建索引依赖列举顺序，此处不随机化
			for await (const copy of this.statShardCopies(
				basename(shardDir),
				files,
			)) {
				yield this.objectFromCopy(copy, dir, trashed);
			}
		}
	}

	/**
	 * 列出 baseDir 下的分片目录（目录名恰为 2 个字符者）。
	 * baseDir 尚未创建（如刚配好目录还没落过盘）时返回空列表：
	 * 目录不存在意味着其中没有任何副本，不是错误。
	 */
	private async listShardDirs(baseDir: string): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(baseDir))) {
			return [];
		}
		const items = await this.app.vault.adapter.list(baseDir);
		return items.folders.filter((folder) => basename(folder).length === 2);
	}

	/**
	 * 解析一个分片目录下的文件列表，逐个 stat 后产出副本。
	 * 逐文件 stat 是目录遍历的主要开销，以受限并发进行（瓶颈是磁盘 IO 而非
	 * 合并批宽，取常规并发度）；产出保持给定的文件顺序，上层按序消费。
	 */
	private statShardCopies(
		shard: string,
		files: Iterable<string>,
	): AsyncGenerator<CASDirCopy> {
		return orderedParallelMap(
			files,
			async (filePath) => {
				const copy = await this.copyFromPath(shard, filePath);
				// 未知命名格式的文件不是副本，不产出
				return copy ? [copy] : [];
			},
			{ limit: DEFAULT_PARALLEL_LIMIT },
		);
	}

	private objectFromCopy(
		copy: CASDirCopy,
		dir: string,
		trashed: boolean,
	): CASMetadataObject {
		return {
			cid: copy.cid,
			indexedAt: new Date(),
			size: copy.stat.size,
			copies: [
				{
					dir,
					trashedAt: trashed ? new Date(copy.stat.mtime) : undefined,
				},
			],
		};
	}

	/**
	 * 把分片目录下的单个文件路径解析为副本：符合 CAS 命名约定时给出 CID 与 stat，
	 * 未知命名格式（外部直接拷入的文件）返回 undefined。文件名的分片与所在目录不符时
	 * 同样忽略；非法 CID 说明外部使用了不兼容的哈希函数，应抛出而非静默忽略。
	 */
	private async copyFromPath(
		shard: string,
		normalizedPath: string,
	): Promise<CASDirCopy | undefined> {
		const base = basename(normalizedPath);
		// CID Base32 编码长度为 59
		if (base.length !== 59 - 1 + 5 || !base.endsWith(".data")) {
			return undefined;
		}
		if (base.slice(-8, -6) !== shard) {
			console.warn("忽略不匹配分片目录的文件", normalizedPath);
			return undefined;
		}
		try {
			const cid = CID.parse("B" + base.slice(0, 58), base32upper);
			const stat = await this.app.vault.adapter.stat(normalizedPath);
			if (stat?.type !== "file") {
				return undefined;
			}
			return { cid, path: normalizedPath, stat };
		} catch (err) {
			throw new Error(
				`go invalid file in cas: ${normalizedPath}: ${String(err)}`,
			);
		}
	}

	formatNormalizePath(dir: string, cid: CID): string {
		return join(dir, this.formatRelPath(cid));
	}

	async restoreIfTrashed(
		cid: CID,
		restoreAllowedDirs?: string[],
	): Promise<boolean> {
		let didRestore = false;
		const copies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			if (match.isTrashed) {
				// 界面按 CID 粒度操作，恢复所有目录的回收站副本
				const src = match.path;
				const relPath = this.formatRelPath(cid);
				// 副本所在目录不在允许恢复目录列表内时迁移到列表第一个目录
				const targetDir = this.resolveRestoreDir(
					match.dir,
					restoreAllowedDirs,
				);
				await this.restoreTrashedCopy(src, targetDir, relPath, cid);
				didRestore = true;
				// 迁移场景按实际目标目录记录，不残留源目录副本
				copies.push({ dir: targetDir, trashedAt: undefined });
			} else {
				// 正常副本保持原位，不做迁移
				copies.push({ dir: match.dir, trashedAt: undefined });
			}
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
		restoreAllowedDirs?: string[],
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined> {
		let didRestore = false;
		let firstNormalPath: string | undefined;
		const copies: { dir: string; trashedAt?: Date }[] = [];
		for await (const match of this.lookup(cid)) {
			if (match.isTrashed) {
				// 尝试从回收站恢复（所有副本统一操作，迁移按允许恢复目录列表）
				const src = match.path;
				const relPath = this.formatRelPath(cid);
				const targetDir = this.resolveRestoreDir(
					match.dir,
					restoreAllowedDirs,
				);
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

				const dst = await this.restoreTrashedCopy(
					src,
					targetDir,
					relPath,
					cid,
				);
				copies.push({ dir: targetDir, trashedAt: undefined });
				firstNormalPath ??= dst;
				didRestore = true;
			} else {
				copies.push({ dir: match.dir, trashedAt: undefined });
				firstNormalPath ??= match.path;
			}
		}
		if (copies.length === 0) {
			this.sync.notifyChanged({ cid });
			return undefined;
		}
		this.sync.notifyChanged({ cid });
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

		// 落盘前交给上层写入策略把关（如下载配额自动清理）；去重命中不新增副本，无需触发
		await this.guard(dir, file.size);

		await makeDirs(this.app.vault, dirname(filePath));
		await this.app.vault.adapter.writeBinary(filePath, arrayBuffer);

		// 落盘成功后仅发布失效信号，由后台消费者按磁盘真相追平索引（不阻塞本调用）
		this.sync.notifyChanged({
			cid,
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

	private getFilePath(dir: string, relPath: string): string {
		return join(dir, relPath);
	}

	private getTrashPath(dir: string, relPath: string): string {
		return join(dir, this.trashRelPath, relPath);
	}

	/**
	 * 恢复目标目录：副本所在目录在允许列表内（或列表为空/未提供）时原位恢复，
	 * 否则迁移到列表第一个目录。仅对回收站副本生效，正常副本不做迁移。
	 */
	private resolveRestoreDir(
		matchDir: string,
		allowedDirs?: string[],
	): string {
		if (
			allowedDirs == null ||
			allowedDirs.length === 0 ||
			allowedDirs.includes(matchDir)
		) {
			return matchDir;
		}
		return allowedDirs[0];
	}

	/**
	 * 把单个回收站副本恢复/迁移到目标目录（restoreIfTrashed 与 load 共用）。
	 * 目标目录可能已存在同 CID 正常副本，冲突时按 moveReplacingFile 去重/坏标。
	 * 返回恢复后的正常路径。
	 */
	private async restoreTrashedCopy(
		src: string,
		targetDir: string,
		relPath: string,
		cid: CID,
	): Promise<string> {
		const dst = this.getFilePath(targetDir, relPath);
		await makeDirs(this.app.vault, dirname(dst));
		await this.moveReplacingFile(src, dst, cid);
		return dst;
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

/**
 * 「目录是否已有回收站」的惰性缓存，一次扫描内复用同一目录的判断结果。
 * 复用范围限于单次调用：重建索引会扫描上万 CID，同一目录的回收站存在性
 * 只需问一次磁盘，但该结论不跨调用，避免外部改动回收站后读到过期结果。
 */
class TrashDirCache {
	private entries = new Map<string, Promise<boolean>>();

	get(dir: string, probe: () => Promise<boolean>): Promise<boolean> {
		let cached = this.entries.get(dir);
		if (!cached) {
			cached = probe();
			this.entries.set(dir, cached);
		}
		return cached;
	}
}

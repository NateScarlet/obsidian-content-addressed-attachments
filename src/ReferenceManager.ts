import type { CID } from "multiformats";
import type ContentAddressedAttachmentPlugin from "./main";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import { ReferenceManagerCacheImpl } from "./infrastructure/indexed-db/ReferenceManagerCache";
import findIPFSLinks from "./utils/findIPFSLinks";
import type parseIPFSLink from "./utils/parseIPFSLink";
import { Notice, type TFile } from "obsidian";
import { mount, unmount } from "svelte";
import IncrementalScanProgress from "./ui/IncrementalScanProgress.svelte";

export interface ReferenceManagerCache {
	add(cid: CID, normalizedPath: string): Promise<void>;
	find(cid: CID): AsyncIterableIterator<string>;
	expireByPath(normalizedPath: string, notAfter: Date): Promise<number>;
	cutoffAt(): Promise<Date>;
	setCutoffAt(v: Date): Promise<void>;
}

export default class ReferenceManager {
	cache: ReferenceManagerCache;
	flight = new SingleFlightGroup();

	constructor(private plugin: ContentAddressedAttachmentPlugin) {
		this.cache = new ReferenceManagerCacheImpl();
	}

	async count(cid: CID, limit: number): Promise<number> {
		if (limit == 0) {
			return 0;
		}
		let count = 0;
		for await (const path of this.findFilePath(cid)) {
			void path;
			count += 1;
			if (count == limit) {
				return count;
			}
		}
		return count;
	}

	async *findFilePath(cid: CID): AsyncIterableIterator<string> {
		const prefix = `ipfs://${cid.toString()}`;
		for await (const normalizedPath of this.cache.find(cid)) {
			if (!(await this.verifyReference(normalizedPath, prefix))) {
				// 缓存过时了，后台进行重建
				this.loadFile(normalizedPath).catch((err) => {
					console.error(`load latest file to cache failed`, err);
				});
				continue;
			}
			yield normalizedPath;
		}
	}

	private async verifyReference(normalizedPath: string, prefix: string) {
		const file = this.plugin.app.vault.getFileByPath(normalizedPath);
		if (!file) {
			return false;
		}
		const content = await this.plugin.app.vault.cachedRead(file);
		return content.includes(prefix);
	}

	private async incrementalScan() {
		await this.flight.do("scan", () => this.doIncrementalScan());
	}

	private async doIncrementalScan() {
		const cutoffAt = await this.cache.cutoffAt();
		const { vault } = this.plugin.app;
		const startAt = new Date();
		const newFiles = vault
			.getMarkdownFiles()
			.filter((file) => file.stat.mtime >= cutoffAt.getTime());
		if (newFiles.length === 0) {
			return;
		}
		using stack = new DisposableStack();
		const notice = stack.adopt(new Notice(new DocumentFragment()), (i) =>
			i.hide(),
		);
		const progress = stack.adopt(
			mount(IncrementalScanProgress, {
				target: notice.containerEl,
				props: {
					totalFiles: newFiles.length,
				},
			}),
			(i) => void unmount(i),
		);

		const jobs: Promise<void>[] = [];
		let nextIndex = 1;
		for (const file of newFiles) {
			jobs.push(
				this.loadFile(file.path).then(() => {
					const index = nextIndex;
					nextIndex += 1;
					progress.currentIndex = index;
					progress.currentFile = file.path;
				}),
			);
		}
		await Promise.all(jobs);
		await this.cache.setCutoffAt(startAt);
	}

	async loadFile(normalizedPath: string) {
		await this.flight.do(`loadFile:${normalizedPath}`, () =>
			this.doLoadFile(normalizedPath),
		);
	}

	private async doLoadFile(normalizedPath: string) {
		const file = this.plugin.app.vault.getFileByPath(normalizedPath);
		const startAt = new Date();
		if (file) {
			const markdown = await this.plugin.app.vault.cachedRead(file);
			const jobs: Promise<void>[] = [];
			for (const { url, title } of findIPFSLinks(markdown)) {
				jobs.push(
					this.cache.add(url.cid, normalizedPath),
					this.plugin.cas.index({
						cid: url.cid,
						indexedAt: new Date(),
						filename: url.filename || title || undefined,
						format: url.format || undefined,
					}),
				);
			}
			await Promise.all(jobs);
		}
		await this.cache.expireByPath(normalizedPath, startAt);
	}

	async clearCache() {
		await this.cache.setCutoffAt(new Date(0));
	}

	async getDefaultFilename(cid: CID): Promise<string> {
		await this.incrementalScan();
		const { vault } = this.plugin.app;
		for await (const normalizedPath of this.cache.find(cid)) {
			const file = vault.getFileByPath(normalizedPath);
			if (!file) {
				this.loadFile(normalizedPath).catch((err) => {
					console.error(`load latest file to cache failed`, err);
				});
				continue;
			}
			const markdown = await vault.cachedRead(file);
			for (const { url, title } of findIPFSLinks(markdown)) {
				if (url.cid.equals(cid)) {
					if (url.filename) {
						return url.filename;
					}
					if (title) {
						return title;
					}
				}
			}
		}
		return cid.toString();
	}

	async *findReference(cid: CID): AsyncIterableIterator<{
		file: TFile;
		pos: [startIndex: number, endIndex: number];
		url: NonNullable<ReturnType<typeof parseIPFSLink>>;
		title?: string;
	}> {
		await this.incrementalScan();
		const { vault } = this.plugin.app;
		for await (const normalizedPath of this.cache.find(cid)) {
			const file = vault.getFileByPath(normalizedPath);
			if (!file) {
				this.loadFile(normalizedPath).catch((err) => {
					console.error(`load latest file to cache failed`, err);
				});
				continue;
			}
			const markdown = await vault.cachedRead(file);
			for (const link of findIPFSLinks(markdown)) {
				if (link.url.cid.equals(cid)) {
					yield {
						...link,
						file,
					};
				}
			}
		}
	}
}

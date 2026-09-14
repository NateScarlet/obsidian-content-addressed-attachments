import { App, Notice, requestUrl, type RequestUrlResponse } from "obsidian";
import mustache from "mustache";
import { CID } from "multiformats/cid";
import isAbortError from "./utils/isAbortError";
import type { Settings } from "./settings";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import type { CAS } from "./types/CAS";
import castError from "./utils/castError";
import computeCID from "./utils/computeCID";
import parseIPFSLockedURL, {
	type IPFSLockedURL,
} from "./utils/parseIPFSLockedURL";
import { ENCRYPTED_FORMAT } from "./lib/encryption/types";
import type EncryptionService from "./lib/encryption/EncryptionService";
import createImagePlaceholderSVG from "./utils/createImagePlaceholderSVG";
import defineLocales from "./utils/defineLocales";
import { applyHeaderRules, headersToRecord } from "./utils/applyHeaderRules";

// 模板数据类型接口
type TemplateLambda = () => (
	text: string,
	render: (text: string) => string,
) => string;

interface TemplateData {
	rawURL: string;
	url: URL;
	cid: CID;

	// 计算函数
	filename: () => string;
	format: () => string;
	casPath: () => string;

	// 辅助函数
	encodeURI: TemplateLambda;
}

export interface GatewayConfig {
	urlTemplate: string;
	name: string;
	headers: [key: string, value: string][];
	enabled: boolean;
	downloadDir?: string;
}

/** 按 URL 前缀匹配的全局请求头规则，命中任意远程请求时附加 headers */
export interface HeaderRule {
	/** URL 前缀，仅当请求 URL 以此开头时应用；空值视为未配置，不匹配任何请求 */
	baseUrl: string;
	headers: [key: string, value: string][];
}

export interface ResolveURLResult {
	path?: string;
	url: string;
	/** 内容的 CID */
	cid: CID;
}

// #region DecryptedCacheManager

/** Manages in-memory blob URLs and on-disk decrypted file caches, decoupled from URL resolution. */
class DecryptedCacheManager {
	private blobStore = new Map<string, string>();

	constructor(
		private adapter: App["vault"]["adapter"],
		private getCacheDir: () => string | undefined,
	) {}

	getBlobUrl(key: string): string | undefined {
		return this.blobStore.get(key);
	}

	createBlobUrl(key: string, blob: Blob): string {
		const url = URL.createObjectURL(blob);
		this.blobStore.set(key, url);
		return url;
	}

	async readDiskCache(filename: string): Promise<string | undefined> {
		const cacheDir = this.getCacheDir();
		if (!cacheDir) return undefined;
		const cachePath = `${cacheDir}/${filename}`;
		const exists = await this.adapter.exists(cachePath);
		return exists ? cachePath : undefined;
	}

	async writeDiskCache(cachePath: string, data: ArrayBuffer): Promise<void> {
		const cacheDir = this.getCacheDir();
		if (!cacheDir) throw new Error("Cache dir not set");
		const cacheDirExists = await this.adapter.exists(cacheDir);
		if (!cacheDirExists) {
			await this.adapter.mkdir(cacheDir);
		}
		await this.adapter.writeBinary(cachePath, data);
	}

	revokeStaleBlobs(activeKeys: Set<string>): void {
		for (const [key, url] of this.blobStore) {
			if (!activeKeys.has(key)) {
				URL.revokeObjectURL(url);
				this.blobStore.delete(key);
			}
		}
	}

	dispose(): void {
		for (const url of this.blobStore.values()) {
			URL.revokeObjectURL(url);
		}
		this.blobStore.clear();
	}

	get blobCount(): number {
		return this.blobStore.size;
	}
}

// #endregion

/**
 * 一个可参与远程竞争的来源：URL、请求头与下载目录均延迟到实际请求时求值，
 * 保证 HEAD 预检与 GET 完整下载使用同一份来源配置。
 */
interface RemoteSource {
	label: string;
	getURL: () => string;
	buildHeaders: () => Headers;
	getDir: () => string;
}

export class URLResolver {
	private flight = new SingleFlightGroup<ResolveURLResult | undefined>();
	// 探测按 Host 去重：同一 Host 的并发探测共享一次请求，结论适用于本批全部来源
	private probeFlight = new SingleFlightGroup<{ rtt: number }>();
	private cacheManager: DecryptedCacheManager;
	// 防抖 cleanup 的 timer ID
	private cleanupTimer: number | undefined;

	constructor(
		private app: App,
		private cas: CAS,
		private settings: () => Settings,
		private encryptionService: EncryptionService,
	) {
		this.cacheManager = new DecryptedCacheManager(
			this.app.vault.adapter,
			() => this.settings().decryptedCacheDir,
		);
	}

	/** 清理所有解密产生的 blob URL 和定时器 */
	[Symbol.dispose](): void {
		if (this.cleanupTimer) {
			window.clearTimeout(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}
		this.cacheManager.dispose();
	}

	async resolveURL(rawURL: string): Promise<ResolveURLResult | undefined> {
		const lockedURL = parseIPFSLockedURL(rawURL);
		if (lockedURL) {
			const format =
				lockedURL.sourceURL.searchParams.get("format") || undefined;
			for await (const match of this.cas.lookup(lockedURL.cid)) {
				if (format === ENCRYPTED_FORMAT) {
					return this.resolveEncryptedFile(match.path, lockedURL.cid);
				}
				return {
					path: match.path,
					url: this.app.vault.adapter.getResourcePath(match.path),
					cid: lockedURL.cid,
				};
			}
			// 本地没有：与标准 IPFS 解析一致，并行请求源站与所有配置的网关，
			// 避免源站失效但其他网关仍可获取内容时解析失败
			const data = this.prepareLockedTemplateData(lockedURL);
			return this.resolveFromRemote(data, [
				lockedURL.sourceURL.toString(),
			]);
		}

		// vault-relative（无协议头）或 HTTP(S) URL
		const isNetworkURL =
			rawURL.startsWith("https://") || rawURL.startsWith("http://");
		const isVaultRelative = rawURL.indexOf(":") < 0;

		if (isVaultRelative || isNetworkURL) {
			const { result } = await this.flight.do(rawURL, () => {
				return isVaultRelative
					? this.resolveVaultRelativePath(rawURL)
					: this.resolveHTTP(rawURL);
			});
			return result;
		}

		// 白名单检查：至此仅接受 ipfs://，其余协议明确报错
		if (!rawURL.startsWith("ipfs://")) {
			throw new Error(
				`Unsupported URL: ${rawURL}. Only vault-relative, http(s), ipfs:// and internal.ipfs-locked: URLs are supported.`,
			);
		}

		const data = this.prepareTemplateData(rawURL);
		const { result } = await this.flight.do(data.cid.toString(), () => {
			return this.doResolveURL(data);
		});
		return result;
	}

	private async readResponse(
		dir: string,
		resp: RequestUrlResponse,
		expected: {
			cid: CID;
			format?: string;
			filename?: string;
		},
	) {
		if (resp.status !== 200) {
			return;
		}
		const { cid, didCreate } = await this.cas.save(
			dir,
			new File(
				[new Blob([resp.arrayBuffer], {})],
				expected.filename ?? "",
				{
					type: (() => {
						const ct = resp.headers["content-type"];
						if (ct && ct !== "application/octet-stream") {
							return ct;
						}
						return expected.format || undefined;
					})(),
				},
			),
		);
		if (!cid.equals(expected.cid)) {
			if (didCreate) {
				await this.cas.trash(cid);
			}
			return;
		}
		const path = this.cas.formatNormalizePath(dir, cid);
		return {
			url: this.app.vault.adapter.getResourcePath(path),
			path,
			cid: expected.cid,
		} satisfies ResolveURLResult;
	}

	/**
	 * 读取 vault-relative 路径的文件，计算 CID 并返回 ResolveURLResult。
	 * 本方法仅接收 vault-relative 路径（无 scheme，如 "path/to/file.js"），
	 * 文件已在 vault 中，无需保存到 CAS。
	 */
	private async resolveVaultRelativePath(
		relPath: string,
	): Promise<ResolveURLResult | undefined> {
		// 文件不存在是合法结果（脚本未配置/未同步），其他读取错误应让调用方可见
		if (!(await this.app.vault.adapter.exists(relPath))) {
			return undefined;
		}
		const content = await this.app.vault.adapter.readBinary(relPath);
		const cid = await computeCID(content);
		return {
			path: relPath,
			url: this.app.vault.adapter.getResourcePath(relPath),
			cid,
		};
	}

	/**
	 * 下载 HTTP(S) URL 的内容，保存到 CAS 并返回 ResolveURLResult。
	 * 网络/存储错误原样向上抛，由调用方决定如何处理。
	 */
	private async resolveHTTP(
		rawURL: string,
	): Promise<ResolveURLResult | undefined> {
		const headers = new Headers();
		applyHeaderRules(rawURL, headers, this.settings().headerRules);
		const resp = await requestUrl({
			url: rawURL,
			headers: headersToRecord(headers),
			throw: false,
		});
		// 404 与 vault-relative 语义一致，视为合法的“资源不存在”；
		// 其他状态码抛错让调用方可见，避免服务器故障被当成文件缺失静默吞掉
		if (resp.status === 404) return undefined;
		if (resp.status !== 200) {
			throw new Error(`HTTP ${resp.status} while resolving ${rawURL}`);
		}
		const dir = this.settings().downloadDir || this.settings().primaryDir;
		const file = new File(
			[resp.arrayBuffer],
			rawURL.split("/").pop() || "download",
		);
		const { cid } = await this.cas.save(dir, file);
		const path = this.cas.formatNormalizePath(dir, cid);
		return {
			path,
			url: this.app.vault.adapter.getResourcePath(path),
			cid,
		};
	}

	private async doResolveURL(
		data: TemplateData,
	): Promise<ResolveURLResult | undefined> {
		// 该路径只处理 ipfs:// 链接，恢复目标固定为主存储目录
		const match = await this.cas.load(data.cid, [
			this.settings().primaryDir,
		]);
		if (match) {
			if (data.format() === ENCRYPTED_FORMAT) {
				return this.resolveEncryptedFile(
					match.normalizedPath,
					data.cid,
				);
			}
			return {
				path: match.normalizedPath,
				url: this.app.vault.adapter.getResourcePath(
					match.normalizedPath,
				),
				cid: data.cid,
			};
		}
		return this.resolveFromRemote(data);
	}

	/**
	 * 探测（probe）：以 no-cors HEAD 测量来源所在 Host 的可达性，并记录往返延迟。
	 * 收到任意 HTTP 响应（no-cors 下为 opaque response，不读内容不看状态码）即视为
	 * Host 可达；仅网络层失败（reject）判为不可达。探测不做跨调用缓存，
	 * 进行中的探测由 SingleFlightGroup 按 Host 去重，取消随最后一个放弃的调用者传播。
	 */
	private probeSource(source: RemoteSource): Promise<{ rtt: number }> {
		const url = source.getURL();
		const host = new URL(url).host;
		return this.probeFlight
			.do(host, async (signal) => {
				const startedAt = performance.now();
				// no-cors 模式不做 CORS 判定且不发送自定义头（浏览器会静默丢弃
				// 非 CORS-safelisted 头），任意服务的任意响应都算"可达"（ADR-0001）
				// eslint-disable-next-line no-restricted-globals -- ADR-0001：requestUrl 不可取消，探测必须用 fetch
				await fetch(url, { method: "HEAD", mode: "no-cors", signal });
				return { rtt: performance.now() - startedAt };
			})
			.then(({ result }) => result);
	}

	/**
	 * 流式消费探测结果：任一来源的探测 settle（可达）即按 settle 顺序
	 * （天然为 RTT 序）开始完整下载，不等待其余仍在飞的探测——挂住的
	 * 探测只影响它自己的来源，不拖住其他健康来源。
	 * 串行下载：同一时刻至多一个 GET 在飞，首个成功即结束。
	 * 全部来源出局且确有异常时提示一次（与既有失败反馈语义一致）。
	 */
	private async resolveFromRemote(
		data: TemplateData,
		extraURLs: string[] = [],
	): Promise<ResolveURLResult | undefined> {
		const sources = this.buildRemoteSources(data, extraURLs);
		if (sources.length === 0) {
			return undefined;
		}
		const errors: unknown[] = [];

		// #region 探测交付队列：并发探测，按 settle 顺序交付给消费者
		const probedQueue: RemoteSource[] = [];
		const probedWaiters: ((source: RemoteSource | undefined) => void)[] =
			[];
		let probedPending = sources.length;

		/** 有消费者等待时直接交付，否则入队。 */
		const enqueueProbed = (source: RemoteSource) => {
			const waiter = probedWaiters.shift();
			if (waiter) {
				waiter(source);
			} else {
				probedQueue.push(source);
			}
		};

		/** 取出下一个探测可达的来源；全部探测结束且无候补时返回 undefined。 */
		const nextProbed = (): Promise<RemoteSource | undefined> => {
			const probed = probedQueue.shift();
			if (probed) return Promise.resolve(probed);
			if (probedPending === 0) return Promise.resolve(undefined);
			return new Promise((resolve) => probedWaiters.push(resolve));
		};

		// 探测失败只收集到 errors，不阻塞其他来源的消费。
		// 有意不限并发：来源数 = 配置的网关 + 源站 extraURLs（个位数），且「全部来源
		// 并发探测、按 settle 顺序串行 GET 回退」是 ADR-0001 / issue #33 的有意设计，
		// 限制并发会改变交付顺序语义。
		void Promise.all(
			sources.map(async (source) => {
				try {
					await this.probeSource(source);
					enqueueProbed(source);
				} catch (error) {
					if (!isAbortError(error)) {
						errors.push(error);
						console.debug(`探测来源 ${source.label} 失败`, error);
					}
				} finally {
					probedPending -= 1;
					if (probedPending === 0) {
						// 唤醒仍在等待的消费者，交付「没有更多候补」
						for (const waiter of probedWaiters.splice(0)) {
							waiter(undefined);
						}
					}
				}
			}),
		);
		// #endregion

		// 串行消费：同一时刻至多一个完整下载在飞
		while (true) {
			const source = await nextProbed();
			if (!source) break;
			try {
				const result = await this.downloadFromSource(source, data);
				if (result) {
					return result;
				}
			} catch (error) {
				if (!isAbortError(error)) {
					errors.push(error);
					console.debug(`解析来源 ${source.label} 失败`, error);
				}
			}
		}

		// 全部来源失败：仅当确有异常时才提示一次（404/CID 不匹配属于合法缺失，保持静默）
		if (errors.length > 0) {
			console.error("解析 IPFS 网址失败", data.rawURL, errors);
			new Notice(t("allSourcesFailed")(castError(errors[0]).message));
		}
		return undefined;
	}

	/**
	 * 对一个探测可达的来源发起完整下载并保存到 CAS。
	 * GET 非 200 视为该来源失败（静默返回 undefined）；网络/存储错误
	 * 向上抛出，由调用方收集错误后决定换下一个来源或结束。
	 */
	private async downloadFromSource(
		source: RemoteSource,
		data: TemplateData,
	): Promise<ResolveURLResult | undefined> {
		const url = source.getURL();
		console.debug("GET", url);
		const resp = await requestUrl({
			url,
			headers: headersToRecord(source.buildHeaders()),
			throw: false,
		});
		if (resp.status !== 200) {
			return undefined;
		}
		console.debug("GOT", resp.headers);
		return this.fetchRemote(source.getDir(), resp, {
			cid: data.cid,
			filename: data.filename(),
			format: data.format(),
		});
	}

	/**
	 * 构建完整的远程来源列表：启用的网关（模板渲染非空者）+ 额外来源
	 * （如 lockedURL 的源站）。网关请求头 = 全局规则 + 网关自身配置
	 * （同名覆盖），未设置时补 Accept；额外来源请求头 = 全局规则。
	 */
	private buildRemoteSources(
		data: TemplateData,
		extraURLs: string[],
	): RemoteSource[] {
		const sources: RemoteSource[] = [];
		for (const config of this.settings().gateways) {
			if (!config.enabled) continue;
			const url = this.renderGatewayURL(data.rawURL, config);
			if (!url) continue;
			sources.push({
				label: config.name,
				getURL: () => url,
				getDir: () =>
					config.downloadDir ||
					this.settings().downloadDir ||
					this.settings().primaryDir,
				buildHeaders: () => {
					const headers = new Headers();
					applyHeaderRules(url, headers, this.settings().headerRules);
					for (const [key, value] of config.headers) {
						headers.set(key, value);
					}
					if (!headers.has("Accept")) {
						headers.set("Accept", data.format() || "*/*");
					}
					return headers;
				},
			});
		}
		for (const url of extraURLs) {
			sources.push({
				label: url,
				getURL: () => url,
				getDir: () =>
					this.settings().downloadDir || this.settings().primaryDir,
				buildHeaders: () => {
					const headers = new Headers();
					applyHeaderRules(url, headers, this.settings().headerRules);
					return headers;
				},
			});
		}
		return sources;
	}

	/**
	 * 将远程响应保存到 CAS 并校验 CID，若是加密格式则再解密后返回。
	 * 下载失败或 CID 不匹配时返回 undefined。
	 */
	private async fetchRemote(
		dir: string,
		resp: RequestUrlResponse,
		expected: { cid: CID; format?: string; filename?: string },
	): Promise<ResolveURLResult | undefined> {
		const downloaded = await this.readResponse(dir, resp, expected);
		if (downloaded && expected.format === ENCRYPTED_FORMAT) {
			return this.resolveEncryptedFile(downloaded.path, expected.cid);
		}
		return downloaded;
	}

	// 生成模板数据
	private prepareTemplateData(rawURL: string): TemplateData {
		const url = new URL(rawURL);
		if (!url || url.protocol != "ipfs:") {
			throw new Error(`invalid url: '${url}'`);
		}
		const cid = CID.parse(url.host);
		if (!cid) {
			throw new Error(`invalid cid in url: '${url}'`);
		}
		const casPath = this.cas.formatRelPath(cid);
		return {
			rawURL,
			url,
			cid,
			filename: () => url.searchParams.get("filename") || "",
			format: () => url.searchParams.get("format") || "",
			casPath: () => casPath,
			encodeURI: () => (text, render) => encodeURIComponent(render(text)),
		};
	}

	/**
	 * 将 lockedURL 的源站 URL 查询参数（format/filename）并入 ipfs:// 模板，
	 * 使网关模板可按 CID 渲染并沿用加密/文件名等语义。
	 */
	private prepareLockedTemplateData(lockedURL: IPFSLockedURL): TemplateData {
		const url = new URL(`ipfs://${lockedURL.cid.toString()}`);
		const format = lockedURL.sourceURL.searchParams.get("format");
		if (format) {
			url.searchParams.set("format", format);
		}
		const filename = lockedURL.filename;
		if (filename) {
			url.searchParams.set("filename", filename);
		}
		return this.prepareTemplateData(url.toString());
	}

	renderGatewayURL(rawURL: string, config: GatewayConfig): string {
		if (!rawURL || !config.urlTemplate) return "";
		const templateData = this.prepareTemplateData(rawURL);
		return mustache.render(config.urlTemplate, templateData, undefined, {
			escape: encodeURIComponent,
		});
	}

	private async resolveEncryptedFile(
		encryptedPath: string,
		cid: CID,
	): Promise<ResolveURLResult | undefined> {
		// 优先检查内存中已有的 blob URL 缓存
		const cachedBlob = this.cacheManager.getBlobUrl(encryptedPath);
		if (cachedBlob) return { url: cachedBlob, path: encryptedPath, cid };

		// 优先检查磁盘缓存
		const cacheFilename = `${cid.toString()}.decrypted`;
		const cachePath = await this.cacheManager.readDiskCache(cacheFilename);

		if (cachePath) {
			return {
				path: cachePath,
				url: this.app.vault.adapter.getResourcePath(cachePath),
				cid,
			};
		}

		try {
			const encryptedData =
				await this.app.vault.adapter.readBinary(encryptedPath);

			const decrypted =
				await this.encryptionService.ensureDecrypted(encryptedData);
			if (decrypted.layers.length === 0) return;

			const size = decrypted.data.byteLength;
			const maxBlob = this.settings().maxBlobSize;

			if (size <= maxBlob) {
				const url = this.cacheManager.createBlobUrl(
					encryptedPath,
					decrypted.toBlob(),
				);
				return { url, path: encryptedPath, cid };
			}

			// 大文件：解密到缓存目录
			const cacheDir = this.settings().decryptedCacheDir;
			if (!cacheDir) {
				console.error(
					`Decrypted cache directory is not set. Cannot cache large decrypted file (${size} bytes) for ${encryptedPath}`,
				);
				new Notice(t("decryptedCacheDirNotSet")(encryptedPath));

				// 仅对图片类型生成图片占位符，其他类型返回简单提示
				const mimeType = decrypted.mimeType;
				const isImage = mimeType.startsWith("image/");

				if (isImage) {
					const svg = createImagePlaceholderSVG(
						t("decryptedCacheDirNotSetPlaceholder"),
						"error",
					);
					return {
						url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
						cid,
					};
				}

				throw new Error(t("decryptedCacheDirNotSetSimple"));
			}

			await this.cacheManager.writeDiskCache(cachePath!, decrypted.data);

			return {
				path: cachePath!,
				url: this.app.vault.adapter.getResourcePath(cachePath!),
				cid,
			};
		} catch (err) {
			console.error("Failed to decrypt file:", encryptedPath, err);
		}
	}

	/**
	 * 清理不再被任何活跃笔记引用的解密缓存文件和 blob URL。
	 * 调用者应在笔记关闭时调用此方法，传入一个生成器函数以惰性产生活跃 CID。
	 * 内部使用 30 秒防抖，避免用户快速切换笔记时频繁清理。
	 *
	 * 缓存文件命名格式为 `<cid>.decrypted`，直接扫描缓存目录匹配此模式，
	 * 而非维护内存映射，确保应用中途崩溃后残留文件也能被正确清理。
	 */
	cleanupDecryptedCache(
		getActiveCids: () => Iterable<string> | AsyncIterable<string>,
	): void {
		if (this.cleanupTimer) {
			window.clearTimeout(this.cleanupTimer);
		}

		this.cleanupTimer = window.setTimeout(() => {
			void (async () => {
				this.cleanupTimer = undefined;
				const cacheDir = this.settings().decryptedCacheDir;

				// 早期返回：无缓存可清理
				if (this.cacheManager.blobCount === 0 && !cacheDir) return;

				// 清理磁盘缓存文件：逐个检查缓存文件，对每个文件用生成器惰性查找活跃 CID，
				// 利用生成器的提前中止特性，找到匹配即停止扫描，避免不必要的全量收集。
				if (cacheDir) {
					try {
						const cacheDirExists =
							await this.app.vault.adapter.exists(cacheDir);
						if (cacheDirExists) {
							const files =
								await this.app.vault.adapter.list(cacheDir);
							for (const filePath of files.files) {
								const fileName =
									filePath.split("/").pop() ?? "";
								if (!fileName.endsWith(".decrypted")) continue;
								// 提取 CID（文件名去掉 .decrypted 后缀）
								const cid = fileName.slice(
									0,
									-".decrypted".length,
								);
								// 惰性检查：遍历活跃 CID 生成器，找到匹配即提前中止
								let isActive = false;
								for await (const activeCid of getActiveCids()) {
									if (activeCid === cid) {
										isActive = true;
										break;
									}
								}
								if (!isActive) {
									try {
										await this.app.vault.adapter.remove(
											filePath,
										);
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
						console.error(
							"Failed to list decrypted cache directory:",
							err,
						);
					}
				}

				// 清理不再引用的 blob URL：收集活跃 CID 用于 Set 查找
				const activeCids = new Set<string>();
				for await (const cid of getActiveCids()) {
					activeCids.add(cid);
				}
				this.cacheManager.revokeStaleBlobs(activeCids);
			})();
		}, 30_000);
	}
}

const { t } = defineLocales({
	en: {
		keyNotFound: (fp: string, path: string) =>
			`Encryption key ${fp} not found. Cannot decrypt ${path}`,
		decryptedCacheDirNotSet: (path: string) =>
			`Decrypted cache directory not configured. Please set Decrypted Cache Dir or increase Max Blob Size for ${path}`,
		decryptedCacheDirNotSetPlaceholder:
			"Decryption cache directory not set",
		decryptedCacheDirNotSetSimple:
			"Decrypted cache directory not configured. Please set Decrypted Cache Dir or increase Max Blob Size.",
		allSourcesFailed: (firstError: string) =>
			`Failed to resolve: all sources failed. ${firstError}`,
	},
	zh: {
		keyNotFound: (fp: string, path: string) =>
			`加密密钥 ${fp} 未找到，无法解密 ${path}`,
		decryptedCacheDirNotSet: (path: string) =>
			`未设置解密缓存目录。请在设置中配置文件解密缓存目录或提高内存解密上限：${path}`,
		decryptedCacheDirNotSetPlaceholder: "未设置解密缓存目录",
		decryptedCacheDirNotSetSimple:
			"未设置解密缓存目录。请在设置中配置文件解密缓存目录或提高内存解密上限。",
		allSourcesFailed: (firstError: string) =>
			`解析失败：所有源均不可用。${firstError}`,
	},
});

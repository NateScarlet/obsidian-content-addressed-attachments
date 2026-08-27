import { App, Notice, requestUrl, type RequestUrlResponse } from "obsidian";
import mustache from "mustache";
import { CID } from "multiformats/cid";
import isAbortError from "./utils/isAbortError";
import type { Settings } from "./settings";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import type { CAS } from "./types/CAS";
import showError from "./utils/showError";
import computeCID from "./utils/computeCID";
import parseIPFSLockedURL from "./utils/parseIPFSLockedURL";
import { ENCRYPTED_FORMAT } from "./lib/encryption/types";
import type EncryptionService from "./lib/encryption/EncryptionService";
import createImagePlaceholderSVG from "./utils/createImagePlaceholderSVG";
import defineLocales from "./utils/defineLocales";

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

export class URLResolver {
	private flight = new SingleFlightGroup<ResolveURLResult | undefined>();
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
			const resp = await requestUrl({
				url: lockedURL.sourceURL.toString(),
				throw: false,
			});
			const downloaded = await this.readResponse(
				this.settings().downloadDir || this.settings().primaryDir,
				resp,
				{
					cid: lockedURL.cid,
					format,
				},
			);
			if (downloaded && format === ENCRYPTED_FORMAT) {
				return this.resolveEncryptedFile(
					downloaded.path,
					lockedURL.cid,
				);
			}
			return downloaded;
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
		const resp = await requestUrl({
			url: rawURL,
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
		using stack = new DisposableStack();
		const match = await this.cas.load(data.cid);
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
		const { gateways: gatewayURLs } = this.settings();
		let remaining = gatewayURLs.length;
		try {
			return await Promise.race(
				gatewayURLs.map((config) => {
					return new Promise<ResolveURLResult | undefined>(
						(resolve) => {
							(async () => {
								stack.defer(() => resolve(undefined)); // 确保退出后所有Promise一定处于完成状态
								try {
									if (!config.enabled) {
										return;
									}
									const url = this.renderGatewayURL(
										data.rawURL,
										config,
									);
									if (!url) {
										return;
									}
									const headers = new Headers(config.headers);
									if (!headers.has("Accept")) {
										headers.set(
											"Accept",
											data.format() || "*/*",
										);
									}
									const headersRecord: Record<
										string,
										string
									> = {};
									headers.forEach((v, k) => {
										headersRecord[k] = v;
									});

									// XXX: requestUrl 接口不支持 signal，没法中途取消，只能先用 HEAD 来预检
									const resp = await requestUrl({
										url,
										method: "HEAD",
										headers: headersRecord,
										throw: false,
									});
									if (resp.status == 200) {
										console.debug("GET", url);
										const resp = await requestUrl({
											url,
											headers: headersRecord,
											throw: false,
										});
										if (resp.status === 200) {
											console.debug("GOT", resp.headers);
											const dir =
												config.downloadDir ||
												this.settings().downloadDir ||
												this.settings().primaryDir;
											const downloaded =
												await this.readResponse(
													dir,
													resp,
													{
														cid: data.cid,
														filename:
															data.filename(),
														format: data.format(),
													},
												);
											if (
												downloaded &&
												data.format() ===
													ENCRYPTED_FORMAT
											) {
												resolve(
													await this.resolveEncryptedFile(
														downloaded.path,
														data.cid,
													),
												);
											} else {
												resolve(downloaded);
											}
										}
										return;
									}
								} finally {
									remaining -= 1;
									if (remaining === 0) {
										resolve(undefined);
									}
								}
							})().catch(showError);
						},
					);
				}),
			);
		} catch (err) {
			if (!isAbortError(err)) {
				console.error("解析 IPFS 网址失败", data.rawURL, err);
			}
		}
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
	},
	zh: {
		keyNotFound: (fp: string, path: string) =>
			`加密密钥 ${fp} 未找到，无法解密 ${path}`,
		decryptedCacheDirNotSet: (path: string) =>
			`未设置解密缓存目录。请在设置中配置文件解密缓存目录或提高内存解密上限：${path}`,
		decryptedCacheDirNotSetPlaceholder: "未设置解密缓存目录",
		decryptedCacheDirNotSetSimple:
			"未设置解密缓存目录。请在设置中配置文件解密缓存目录或提高内存解密上限。",
	},
});

import { App, Notice, requestUrl, type RequestUrlResponse } from "obsidian";
import mustache from "mustache";
import { CID } from "multiformats/cid";
import isAbortError from "./utils/isAbortError";
import type { Settings } from "./settings";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import type { CAS } from "./types/CAS";
import showError from "./utils/showError";
import parseIPFSLockedURL from "./utils/parseIPFSLockedURL";
import { ENCRYPTED_FORMAT } from "./lib/encryption/types";
import type { EncryptionService } from "./lib/encryption/EncryptionService";
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
}

export class URLResolver {
	private flight = new SingleFlightGroup<ResolveURLResult | undefined>();
	private decryptedBlobStore = new Map<string, string>();

	constructor(
		private app: App,
		private cas: CAS,
		private settings: () => Settings,
		private encryptionService?: EncryptionService,
	) {}

	/** 清理所有解密产生的 blob URL */
	revokeAllBlobs(): void {
		for (const url of this.decryptedBlobStore.values()) {
			URL.revokeObjectURL(url);
		}
		this.decryptedBlobStore.clear();
	}

	async resolveURL(rawURL: string): Promise<ResolveURLResult | undefined> {
		const lockedURL = parseIPFSLockedURL(rawURL);
		if (lockedURL) {
			for await (const match of this.cas.lookup(lockedURL.cid)) {
				return {
					path: match.path,
					url: this.app.vault.adapter.getResourcePath(match.path),
				};
			}
			const resp = await requestUrl({
				url: lockedURL.sourceURL.toString(),
				throw: false,
			});
			return this.readResponse(
				this.settings().downloadDir || this.settings().primaryDir,
				resp,
				{
					cid: lockedURL.cid,
				},
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
		} satisfies ResolveURLResult;
	}

	private async doResolveURL(
		data: TemplateData,
	): Promise<ResolveURLResult | undefined> {
		using stack = new DisposableStack();
		const match = await this.cas.load(data.cid);
		if (match) {
			if (
				data.format() === ENCRYPTED_FORMAT &&
				this.encryptionService?.isAvailable
			) {
				return this.resolveEncryptedFile(match.normalizedPath);
			}
			return {
				path: match.normalizedPath,
				url: this.app.vault.adapter.getResourcePath(
					match.normalizedPath,
				),
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
											resolve(
												await this.readResponse(
													dir,
													resp,
													{
														cid: data.cid,
														filename:
															data.filename(),
														format: data.format(),
													},
												),
											);
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
	): Promise<ResolveURLResult | undefined> {
		if (!this.encryptionService) return;

		try {
			const encryptedData =
				await this.app.vault.adapter.readBinary(encryptedPath);

			if (
				!this.encryptionService.cryptoService.isEncryptedData(
					encryptedData,
				)
			)
				return;

			const header =
				this.encryptionService.cryptoService.parseHeader(encryptedData);
			const key = await this.encryptionService.keyManager.getKey(
				header.keyFingerprint,
			);
			if (!key) {
				console.warn(
					`Encryption key ${header.keyFingerprint} not found for ${encryptedPath}`,
				);
				new Notice(
					t("keyNotFound")(header.keyFingerprint, encryptedPath),
				);
				return;
			}

			const plaintext =
				await this.encryptionService.cryptoService.decrypt(
					key,
					encryptedData,
				);

			const size = plaintext.byteLength;
			const maxBlob = this.encryptionService.maxBlobSize;

			if (size <= maxBlob) {
				const blob = new Blob([plaintext], {
					type: header.originalFormat || "application/octet-stream",
				});
				const url = URL.createObjectURL(blob);
				this.decryptedBlobStore.set(encryptedPath, url);
				return { url };
			}

			// 大文件：解密到临时缓存目录
			const cacheDir = this.settings().decryptedCacheDir;
			if (!cacheDir) {
				console.error(
					`Decrypted cache directory is not set. Cannot cache large decrypted file (${size} bytes) for ${encryptedPath}`,
				);
				new Notice(t("decryptedCacheDirNotSet")(encryptedPath));
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="100%" height="100%" fill="%232d3748"/><text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="%23e2e8f0" font-family="sans-serif" font-size="14">Decryption cache directory not set</text><text x="50%" y="65%" dominant-baseline="middle" text-anchor="middle" fill="%23a0aec0" font-family="sans-serif" font-size="12">Please set Decrypted Cache Dir or increase Max Blob Size</text></svg>`;
				return {
					url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
				};
			}

			const cacheFilename = `dec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const cachePath = `${cacheDir}/${cacheFilename}`;

			const cacheDirExists =
				await this.app.vault.adapter.exists(cacheDir);
			if (!cacheDirExists) {
				await this.app.vault.adapter.mkdir(cacheDir);
			}

			await this.app.vault.adapter.writeBinary(cachePath, plaintext);

			return {
				path: cachePath,
				url: this.app.vault.adapter.getResourcePath(cachePath),
			};
		} catch (err) {
			console.error("Failed to decrypt file:", encryptedPath, err);
		}
	}
}

const { t } = defineLocales({
	en: {
		keyNotFound: (fp: string, path: string) =>
			`Encryption key ${fp} not found. Cannot decrypt ${path}`,
		decryptedCacheDirNotSet: (path: string) =>
			`Decrypted cache directory not configured. Please set Decrypted Cache Dir or increase Max Blob Size for ${path}`,
	},
	zh: {
		keyNotFound: (fp: string, path: string) =>
			`加密密钥 ${fp} 未找到，无法解密 ${path}`,
		decryptedCacheDirNotSet: (path: string) =>
			`未设置解密缓存目录。请在设置中配置文件解密缓存目录或提高内存解密上限：${path}`,
	},
});

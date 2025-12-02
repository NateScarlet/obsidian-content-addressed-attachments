import { App, requestUrl } from "obsidian";
import mustache from "mustache";
import { CID } from "multiformats/cid";
import isAbortError from "./utils/isAbortError";
import type { Settings } from "./settings";
import SingleFlightGroup from "./utils/SingleFlightGroup";
import type { CAS } from "./types/CAS";
import showError from "./utils/showError";

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

	constructor(
		private app: App,
		private cas: CAS,
		private settings: () => Settings,
	) {}

	async resolveURL(rawURL: string): Promise<ResolveURLResult | undefined> {
		const data = this.prepareTemplateData(rawURL);
		const { result } = await this.flight.do(data.cid.toString(), () => {
			return this.doResolveURL(data);
		});
		return result;
	}

	private async doResolveURL(
		data: TemplateData,
	): Promise<ResolveURLResult | undefined> {
		using stack = new DisposableStack();
		const match = await this.cas.load(data.cid);
		if (match) {
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
												this.settings().primaryDir;
											const { cid, didCreate } =
												await this.cas.save(
													dir,
													new File(
														[
															new Blob(
																[
																	resp.arrayBuffer,
																],
																{},
															),
														],
														data.filename() || "",
														{
															type: (() => {
																const ct =
																	resp
																		.headers[
																		"content-type"
																	];
																if (
																	ct &&
																	ct !==
																		"application/octet-stream"
																) {
																	return ct;
																}
																return (
																	data.format() ||
																	undefined
																);
															})(),
														},
													),
												);
											if (!cid.equals(data.cid)) {
												if (didCreate) {
													await this.cas.trash(cid);
												}
												return;
											}
											resolve({
												url: this.app.vault.adapter.getResourcePath(
													this.cas.formatNormalizePath(
														dir,
														cid,
													),
												),
											});
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
}

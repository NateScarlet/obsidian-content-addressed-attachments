import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";

export interface IPFSLinkOptions {
	cid: CID;
	filename?: string;
	format?: string;
}

export class IPFSLink {
	readonly cid: CID;
	readonly filename: string;
	readonly format: string;

	constructor(options: IPFSLinkOptions) {
		this.cid = options.cid;
		this.filename = options.filename ?? "";
		this.format = options.format ?? "";
	}

	get url(): URL {
		return new URL(this.toURL());
	}

	/**
	 * 解析字符串（支持 ipfs:// 开头的完整 URL 或链接文本）
	 */
	static parse(rawURL: string): IPFSLink | undefined {
		if (!rawURL.startsWith("ipfs://")) return undefined;
		try {
			const url = new URL(rawURL);
			if (url.hostname.length !== 59) return undefined;
			const cid = CID.parse(url.hostname);
			const filename = url.searchParams.get("filename") ?? "";
			const format = url.searchParams.get("format") ?? "";
			return new IPFSLink({ cid, filename, format });
		} catch {
			return undefined;
		}
	}

	/** 转换为标准 ipfs:// URL 字符串 */
	toURL(): string {
		const url = new URL(`ipfs://${this.cid.toString()}`);
		if (this.filename) {
			url.searchParams.set("filename", this.filename);
		}
		if (this.format) {
			url.searchParams.set("format", this.format);
		}
		return url.toString();
	}

	/** 转换为 Markdown 格式链接 */
	toMarkdown(embed: boolean): string {
		const urlStr = this.toURL();
		const name = this.filename || (embed ? "image" : "attachment");
		return embed ? `![${name}](${urlStr})` : `[${name}](${urlStr})`;
	}

	toString(): string {
		return this.toURL();
	}
}

import { CID } from "multiformats/cid";
import mimeTypeByExtension from "./mimeTypeByExtension";

export interface IPFSLinkOptions {
	cid: CID;
	filename?: string;
	format?: string;
}

export default class IPFSLink {
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
	 * 解析字符串（支持 ipfs:// 开头的完整 URL 或包含 ipfs:// 的 Markdown 链接文本）
	 */
	static parse(rawURL: string): IPFSLink | undefined {
		const match = rawURL.match(/ipfs:\/\/[b[a-z2-7]{58}[^\s)]*/i);
		if (!match) return undefined;
		try {
			const url = new URL(match[0]);
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

	resolveMimeType(): string {
		if (this.format) return this.format;
		const dotIndex = this.filename.lastIndexOf(".");
		if (dotIndex === -1) return "application/octet-stream";
		return mimeTypeByExtension(this.filename.slice(dotIndex));
	}
}

import type { CID } from "multiformats";

export default function formatMarkdownLink(file: File, cid: CID): string {
	const url = new URL(`ipfs://${cid.toString()}`);
	if (file.name) {
		url.searchParams.set("filename", file.name);
	}
	if (file.type) {
		url.searchParams.set("format", file.type);
	}
	if (file.type.startsWith("image/")) {
		return `![${file.name || "image"}](${url})`;
	} else {
		return `[${file.name ?? "attachment"}](${url})`;
	}
}

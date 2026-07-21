import type { CID } from "multiformats";
import { ENCRYPTED_FORMAT } from "../lib/encryption/types";

export default function formatMarkdownLink(
	file: File,
	cid: CID,
	encrypted?: boolean,
): string {
	const url = new URL(`ipfs://${cid.toString()}`);
	if (file.name) {
		url.searchParams.set("filename", file.name);
	}
	if (encrypted) {
		url.searchParams.set("format", ENCRYPTED_FORMAT);
	} else if (file.type) {
		url.searchParams.set("format", file.type);
	}
	if (file.type.startsWith("image/") && !encrypted) {
		return `![${file.name || "image"}](${url})`;
	} else {
		return `[${file.name ?? "attachment"}](${url})`;
	}
}

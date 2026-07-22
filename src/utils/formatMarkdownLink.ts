import type { CID } from "multiformats";
import { ENCRYPTED_FORMAT } from "../lib/encryption/types";

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i;

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
	const isImage =
		file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
	if (isImage) {
		return `![${file.name || "image"}](${url})`;
	} else {
		return `[${file.name ?? "attachment"}](${url})`;
	}
}

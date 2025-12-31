import { CID } from "multiformats";
import { basename } from "path-browserify";

export type IPFSLockedURL = NonNullable<ReturnType<typeof parseIPFSLockedURL>>;

const prefix = "internal.ipfs-locked:";

export default function parseIPFSLockedURL(rawURL: string) {
	if (rawURL.startsWith(prefix)) {
		const commaIndex = rawURL.indexOf(",", prefix.length);
		if (commaIndex < 0) {
			return;
		}
		const rawSourceURL = rawURL.slice(commaIndex + 1);
		if (!rawSourceURL) {
			return;
		}
		try {
			const sourceURL = new URL(rawSourceURL);
			const cid = CID.parse(rawURL.slice(prefix.length, commaIndex));
			return {
				cid,
				sourceURL,
				get filename() {
					return basename(sourceURL.pathname);
				},
				toString() {
					return rawURL;
				},
			};
		} catch {
			return;
		}
	}
}

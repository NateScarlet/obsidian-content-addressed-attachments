/* eslint-disable @typescript-eslint/no-deprecated */
import { CID } from "multiformats";

export type IPFSStandardURL = NonNullable<ReturnType<typeof parseIPFSLink>>;

/**
 * @deprecated Use `IPFSLink.parse` instead.
 * TODO: Pending migration refactoring.
 */
export default function parseIPFSLink(rawURL: string) {
	if (rawURL.startsWith("ipfs://")) {
		const url = new URL(rawURL);
		if (url.hostname.length != 59) {
			return;
		}
		const cid = CID.parse(url.hostname);
		return {
			cid,
			url,
			get filename() {
				return url.searchParams.get("filename") ?? "";
			},
			get format() {
				return url.searchParams.get("format") ?? "";
			},
			toString() {
				return rawURL;
			},
		};
	}
}

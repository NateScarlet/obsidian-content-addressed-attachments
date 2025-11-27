import type { CID } from "multiformats";

export default interface ReferenceCache {
	add(cid: CID, normalizedPath: string): void;
	expire(cid: CID, notAfter: Date): number;
	get(cid: CID): string[];
}

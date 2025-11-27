import type { CID } from "multiformats";
import type { CASMetadataObject } from "./CASMetadata";
import type { Stat } from "obsidian";

export interface CAS {
	formatRelPath(cid: CID): string;
	formatNormalizePath(cid: CID): string;
	trash(cid: CID, invalid?: boolean): Promise<boolean>;
	load(
		cid: CID,
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined>;
	save(file: File): Promise<{ cid: CID; didCreate: boolean }>;
	deleteIfTrashed(cid: CID): Promise<boolean>;
	objects(): AsyncIterableIterator<CASMetadataObject>;
	/** 索引元数据，使其和实际一致 */
	index(meta: CASMetadataObject): Promise<void>;
	lookup(cid: CID): Promise<
		| {
				path: string;
				stat: Stat;
				isTrashed: boolean;
		  }
		| undefined
	>;
}

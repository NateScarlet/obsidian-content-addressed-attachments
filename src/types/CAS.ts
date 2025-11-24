import type { CID } from "multiformats";
import type { CASMetadataObject } from "./CASMetadata";

export interface CAS {
	formatRelPath(cid: CID): string;
	formatNormalizePath(cid: CID): string;
	trash(cid: CID, invalid?: boolean): Promise<boolean>;
	load(
		cid: CID,
	): Promise<{ normalizedPath: string; didRestore: boolean } | undefined>;
	save(file: File): Promise<{ cid: CID; didCreate: boolean }>;
	delete(cid: CID): Promise<void>;
	objects(): AsyncIterableIterator<CASMetadataObject>;
}

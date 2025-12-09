import type { CID } from "multiformats";

export interface CASMetadataObject {
	cid: CID;
	indexedAt: Date;

	filename?: string;
	format?: string;
	size?: number;

	trashedAt?: Date;
}

export interface CASMetadataObjectFilters {
	cid?: CID[];
	query?: string;
	hasReference?: boolean;
	isTrashed?: boolean;
}

export interface CASMetadata {
	get(cid: CID): Promise<CASMetadataObject | undefined>;
	merge(obj: CASMetadataObject): Promise<{ didCreate: boolean }>;
	delete(cid: CID): Promise<void>;
	/** 固定使用索引时间降序排列，不支持其他排序 */
	find(options: {
		signal: AbortSignal | undefined;
		filterBy?: CASMetadataObjectFilters;
		after?: string;
	}): AsyncIterableIterator<{
		node: CASMetadataObject;
		cursor: string;
	}>;
	estimateStorage(): Promise<{
		normalBytes: number;
		trashBytes: number;
	}>;
}

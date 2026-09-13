import type { TFile } from "obsidian";
import type { CASMetadataObject } from "./types/CASMetadata";
import defineCustomEvent from "./utils/defineCustomEvent";
import type { CID } from "multiformats";

export const casMetadataSave = defineCustomEvent<CASMetadataObject>();

/** 批量保存事件：mergeBatch 等批量写入路径按节流间隔派发的聚合变更 */
export const casMetadataBatchSave = defineCustomEvent<CASMetadataObject[]>();

export const casMetadataDelete = defineCustomEvent<CASMetadataObject>();

export const referenceChange = defineCustomEvent<{
	cid: CID;
	path: string;
	action: "add" | "remove";
}>();

export const markdownChange = defineCustomEvent<TFile>();

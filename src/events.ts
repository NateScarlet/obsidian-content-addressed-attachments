import type { TFile } from "obsidian";
import type { CASMetadataObject } from "./types/CASMetadata";
import type { CASMetadataDirty } from "./types/CASMetadataSync";
import defineCustomEvent from "./utils/defineCustomEvent";
import type { CID } from "multiformats";

/** 写侧失效信号：CAS 落盘事实后发布，提示该 CID 索引需按磁盘追平（消费端自行探测重建） */
export const casMetadataChanged = defineCustomEvent<CASMetadataDirty>();

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

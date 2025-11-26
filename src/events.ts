import type { CASMetadataObject } from "./types/CASMetadata";
import defineCustomEvent from "./utils/defineCustomEvent";
import type { CID } from "multiformats";

const PREFIX = "plugin:content-addressed-attachments:";

export const casMetadataSave = defineCustomEvent<CASMetadataObject>(
	`${PREFIX}cas-metadata-save`,
);

export const casMetadataDelete = defineCustomEvent<CASMetadataObject>(
	`${PREFIX}cas-metadata-delete`,
);

export const referenceChange = defineCustomEvent<{
	cid: CID;
	path: string;
	action: "add" | "remove";
}>(`${PREFIX}reference-change`);

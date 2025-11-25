import type { CASMetadataObject } from "./types/CASMetadata";
import defineCustomEvent from "./utils/defineCustomEvent";

const PREFIX = "plugin:content-addressed-attachments:";

export const casMetadataSave = defineCustomEvent<CASMetadataObject>(
	`${PREFIX}cas-metadata-save`,
);

export const casMetadataDelete = defineCustomEvent<CASMetadataObject>(
	`${PREFIX}cas-metadata-delete`,
);

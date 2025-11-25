import type { CASMetadataObject } from "./types/CASMetadata";
import defineCustomEvent from "./utils/defineCustomEvent";

const prefix = "plugin:content-addressed-attachments:";

export const casMetadataSaved = defineCustomEvent<CASMetadataObject>(
	`${prefix}cas-metadata-saved`,
);

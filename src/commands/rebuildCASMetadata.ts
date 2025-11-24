import type { CASMetadataObject, CASMetadata } from "src/types/CASMetadata";

export default async function rebuildCASMetadata(
	meta: CASMetadata,
	objects: AsyncIterable<CASMetadataObject>,
) {
	for await (const obj of objects) {
		await meta.save(obj);
	}
}

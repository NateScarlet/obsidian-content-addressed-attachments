import type ReferenceManager from "./ReferenceManager";
import type {
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "./types/CASMetadata";
import ExactSearchMatcher from "./utils/ExactSearchMatcher";
import FilterBuilder from "./utils/FilterBuilder";

export default class CASMetadataObjectFilterBuilder {
	constructor(private referenceManager: ReferenceManager) {}
	build(
		filterBy: CASMetadataObjectFilters,
	): (obj: CASMetadataObject) => Promise<boolean> {
		const b = new FilterBuilder<CASMetadataObject>();
		if (filterBy.cid) {
			const m = new Set(filterBy.cid.map((i) => i.toString()));
			b.add((i) => m.has(i.cid.toString()));
		}
		if (filterBy.query) {
			const m = new ExactSearchMatcher(filterBy.query);
			b.add((i) => m.match(i.cid.toString(), i.filename ?? ""));
		}
		if (filterBy.isTrashed) {
			const m = filterBy.isTrashed;
			b.add((i) => (i.trashedAt != null) === m);
		}
		if (filterBy.hasReference) {
			const m = filterBy.hasReference;
			b.add(async (i) => {
				const n = await this.referenceManager.count(
					i.cid,
					1,
					undefined,
				);
				return m === n > 0;
			});
		}
		return b.build();
	}
}

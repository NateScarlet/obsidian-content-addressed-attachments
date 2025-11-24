import type {
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "./types/CASMetadata";
import ExactSearchMatcher from "./utils/ExactSearchMatcher";
import FilterBuilder from "./utils/FilterBuilder";

export default class CASMetadataObjectFilterBuilder {
	build(
		filterBy: CASMetadataObjectFilters,
	): (obj: CASMetadataObject) => boolean {
		const b = new FilterBuilder<CASMetadataObject>();
		if (filterBy.query) {
			const m = new ExactSearchMatcher(filterBy.query);
			b.add((i) => m.match(i.cid.toString(), i.filename ?? ""));
		}
		if (filterBy.isTrashed) {
			const m = filterBy.isTrashed;
			b.add((i) => (i.trashedAt != null) === m);
		}
		return b.build();
	}
}

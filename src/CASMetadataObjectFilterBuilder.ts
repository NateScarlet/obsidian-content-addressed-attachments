import type ReferenceManager from "./ReferenceManager";
import type {
	CASMetadataObject,
	CASMetadataObjectFilters,
} from "./types/CASMetadata";
import { isCASObjectTrashed } from "./utils/casCopies";
import ExactSearchMatcher from "./utils/ExactSearchMatcher";
import FilterBuilder from "./utils/FilterBuilder";

export default class CASMetadataObjectFilterBuilder {
	constructor(
		private referenceManager: ReferenceManager,
		private signal: AbortSignal | undefined = undefined,
	) {}
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
		if (filterBy.isTrashed != null) {
			const m = filterBy.isTrashed;
			b.add((i) => isCASObjectTrashed(i) === m);
		}
		if (filterBy.hasReference != null) {
			const m = filterBy.hasReference;
			// 构建时（惰性，仅当筛选关心引用状态）先确保缓存最新，
			// 之后信任缓存条目判定，不再逐条读笔记内容验证；
			// 失败自然传播（引用判定无法安全继续）
			const ensureFresh = this.referenceManager.ensureFresh(this.signal);
			b.add(async (i) => {
				await ensureFresh;
				const n = await this.referenceManager.count(
					i.cid,
					1,
					this.signal,
					{ skipVerify: true },
				);
				return m === n > 0;
			});
		}
		return b.build();
	}
}

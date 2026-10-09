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
			// 默认保障缓存最新后再信任缓存条目判定（skipVerify），避免缓存过时时列表不准。
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
		if (filterBy.unverifiedHasReference != null) {
			const m = filterBy.unverifiedHasReference;
			// 独立的引用状态筛选，不依赖 hasReference：跳过 ensureFresh，直接信任缓存
			// 做存在性判定，作为「未引用」页加载加速的取舍（缓存未刷新前结果可能短暂不准确）。
			// 与 hasReference 各自独立叠加；两者语义相悖时结果为空集，此类查询无实际用途。
			b.add(async (i) => {
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

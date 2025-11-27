type FilterInput<T> = (v: T) => Promise<boolean> | boolean;
export type Filter<T> = (v: T) => Promise<boolean>;
export default class FilterBuilder<T> {
	private s: FilterInput<T>[] = [];

	public readonly add = (filter: FilterInput<T>) => {
		this.s.push(filter);
	};

	public readonly build = (): Filter<T> => {
		return async (v: T) => {
			for (const test of this.s) {
				if (!(await test(v))) {
					return false;
				}
			}
			return true;
		};
	};
}

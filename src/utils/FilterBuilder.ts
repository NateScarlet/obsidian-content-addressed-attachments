export type Filter<T> = (v: T) => boolean;
export default class FilterBuilder<T> {
	private s: Filter<T>[] = [];

	public readonly add = (filter: Filter<T>) => {
		this.s.push(filter);
	};

	public readonly build = (): Filter<T> => {
		return (v: T) => {
			return this.s.every((i) => i(v));
		};
	};
}

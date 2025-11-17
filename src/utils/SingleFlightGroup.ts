export default class SingleFlightGroup<T = void> {
	private promises = new Map<string, Promise<T>>();

	public readonly do = async (
		key: string,
		cb: () => Promise<T>,
	): Promise<{ result: T; isShared: boolean }> => {
		const existed = this.promises.get(key);
		if (existed) {
			return { result: await existed, isShared: true };
		}
		const p = cb();
		this.promises.set(key, p);
		try {
			return { result: await p, isShared: false };
		} finally {
			this.promises.delete(key);
		}
	};
}

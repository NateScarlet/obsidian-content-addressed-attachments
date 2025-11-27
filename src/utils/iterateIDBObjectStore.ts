import executeIDBRequest from "./executeIDBRequest";

export default async function* iterateIDBObjectStore<TData, TResult>({
	after,
	open,
	decode,
	batchSize = 128,
	signal,
}: {
	signal: AbortSignal | undefined;
	after?: string | undefined;
	open: (after?: string) => Promise<{
		cursor: IDBCursorWithValue | null | undefined;
		close: () => void;
	}>;
	decode: (data: TData) => { node: TResult; cursor: string };
	batchSize?: number;
}) {
	signal?.throwIfAborted();
	const batch: TData[] = [];
	let hasMore = true;
	while (hasMore) {
		const openResult = await open(after);
		const { close } = openResult;
		let { cursor } = openResult;
		if (cursor == null) {
			return;
		}
		try {
			while (cursor && (batchSize <= 0 || batch.length < batchSize)) {
				batch.push(cursor.value as TData);
				cursor.continue();
				cursor = await executeIDBRequest(
					cursor.request as IDBRequest<IDBCursorWithValue | null>,
					signal,
				);
			}
		} finally {
			close();
		}
		for (const po of batch) {
			const edge = decode(po);
			yield edge;
			signal?.throwIfAborted();
			after = edge.cursor;
		}
		hasMore = batchSize > 0 && batch.length === batchSize;
		batch.length = 0;
	}
}

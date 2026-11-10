/**
 * 逐块读取 Web 流的响应体或文件流。
 * 消费方提前结束迭代（取消或出错）时取消底层流；`signal` 中止时抛出 AbortError。
 */
export default async function* readStreamChunks(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
	let finished = false;
	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				return;
			}
			if (value.byteLength > 0) {
				yield value;
			}
		}
	} finally {
		if (!finished) {
			void reader.cancel();
		}
	}
}

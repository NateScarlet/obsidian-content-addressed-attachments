import type { ByteSource } from "#src/types/CAS";
import readStreamChunks from "#src/utils/readStreamChunks";

/**
 * 把内存中的 File/Blob 适配成字节来源。
 * 必须走 `file.stream()` 分块读取，不得退化成 `arrayBuffer()` 整体读入。
 */
export default function fileToByteSource(file: File): ByteSource {
	return {
		name: file.name,
		type: file.type || undefined,
		size: file.size,
		open: () => readStreamChunks(file.stream().getReader()),
	};
}

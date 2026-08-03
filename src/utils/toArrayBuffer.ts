/** 支持的统一二进制输入载体 */
export type BinaryInput = Blob | File | ArrayBuffer | Uint8Array;

/**
 * 从 ArrayBufferView 安全提取底层 ArrayBuffer。
 * TypedArray.buffer 可能返回 SharedArrayBuffer，此函数确保返回 ArrayBuffer。
 */
export function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
	return (view.buffer as ArrayBuffer).slice(
		view.byteOffset,
		view.byteOffset + view.byteLength,
	);
}

/**
 * 将任意 BinaryInput 安全转换为 ArrayBuffer。
 * 同步处理 ArrayBuffer / ArrayBufferView，异步读取 Blob / File。
 */
export default async function toArrayBufferFromBinary(
	input: BinaryInput,
): Promise<ArrayBuffer> {
	if (input instanceof ArrayBuffer) {
		return input;
	}
	if (ArrayBuffer.isView(input)) {
		return toArrayBuffer(input);
	}
	if (input instanceof Blob) {
		return input.arrayBuffer();
	}
	throw new Error("Unsupported binary input format");
}

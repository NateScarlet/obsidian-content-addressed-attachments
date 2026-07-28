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
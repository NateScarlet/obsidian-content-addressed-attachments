import type {
	CASMetadataCopy,
	CASMetadataObject,
} from "#src/types/CASMetadata";

/**
 * 按副本实例合并：同目录可同时存在正常与回收两个实例（per-instance 模型），
 * 各自独立覆盖。changes 覆盖对应的实例槽位，其余实例保留。
 * 调用方只需传入本次涉及的增量，不需要重新扫描磁盘。
 */
export function mergeCopies(
	existing: CASMetadataCopy[] | undefined,
	changes: CASMetadataCopy[],
): CASMetadataCopy[] {
	const map = new Map<string, Date | undefined>();
	for (const c of existing ?? []) map.set(instanceKey(c), c.trashedAt);
	for (const c of changes) map.set(instanceKey(c), c.trashedAt);
	return [...map].map(([key, trashedAt]) => ({
		dir: dirOfKey(key),
		trashedAt,
	}));
}

/** 实例唯一键：目录 + 是否回收。用控制字符作分隔，路径不可能包含，避免碰撞 */
function instanceKey(c: CASMetadataCopy): string {
	return c.trashedAt != null ? `${c.dir}\u0002` : `${c.dir}\u0001`;
}

function dirOfKey(key: string): string {
	return key.slice(0, -1);
}

/** 是否存在处于回收站的副本 */
export function hasTrashCopy(copies: CASMetadataCopy[] | undefined): boolean {
	return copies?.some((c) => c.trashedAt != null) ?? false;
}

/** 对象是否处于回收站（任一目录副本被回收） */
export function isCASObjectTrashed(obj: CASMetadataObject): boolean {
	return hasTrashCopy(obj.copies);
}

/** 最早进入回收站的时间，用于 UI 展示 */
export function firstTrashedAt(obj: CASMetadataObject): Date | undefined {
	let result: Date | undefined;
	for (const c of obj.copies ?? []) {
		if (c.trashedAt != null && (result == null || c.trashedAt < result)) {
			result = c.trashedAt;
		}
	}
	return result;
}

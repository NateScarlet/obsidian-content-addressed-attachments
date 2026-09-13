/**
 * 外部删除对账：找出引用缓存中记录、但 vault 中已不存在的笔记路径。
 * 增量扫描按 mtime 只能看到「改动过的文件」，无法感知「文件消失」，
 * 该差集补上外部删除（插件未运行时删除笔记）的缺口。
 * 纯函数：输入缓存路径集合与当前路径集合，输出应清除的路径列表。
 */
export default function pruneDeletedPaths(
	cachedPaths: ReadonlySet<string>,
	currentPaths: ReadonlySet<string>,
): string[] {
	const pruned: string[] = [];
	for (const path of cachedPaths) {
		if (!currentPaths.has(path)) {
			pruned.push(path);
		}
	}
	return pruned;
}

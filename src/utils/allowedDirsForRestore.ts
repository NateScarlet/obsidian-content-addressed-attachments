/**
 * 计算某 cid 恢复时允许落盘的目录列表：
 * - 存在 ipfs:// 形式引用 → 只允许主存储目录（附件类内容回到规范位置）；
 * - 仅 internal.ipfs-locked: 锁定引用 → 只允许下载目录列表；
 * - 下载目录为空 → undefined（由恢复实现回退为原位恢复，与
 *   「下载目录未配置时锁定文件本就落盘主存储目录」的保存语义一致）。
 */
export default function allowedDirsForRestore(
	hasIPFSReference: boolean,
	primaryDir: string,
	downloadDirs: string[],
): string[] | undefined {
	if (hasIPFSReference) {
		return [primaryDir];
	}
	return downloadDirs.length > 0 ? downloadDirs : undefined;
}

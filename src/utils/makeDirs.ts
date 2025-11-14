import { Vault } from "obsidian";

/**
 * 递归按需创建目录
 */
export default async function makeDirs(
	vault: Vault,
	normalizedPath: string,
): Promise<void> {
	if (!normalizedPath) {
		return;
	}
	if (normalizedPath === "/") {
		return;
	}

	// 检查目录是否已存在
	const existingFolder = vault.getFolderByPath(normalizedPath);
	if (existingFolder) {
		return;
	}

	// 分割路径为各个部分
	const pathParts = normalizedPath.split("/").filter((part) => part !== "");

	let currentPath = "";

	// 逐级创建目录
	for (const part of pathParts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		try {
			await vault.createFolder(currentPath);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message === "Folder already exists."
			) {
				continue;
			} else {
				throw err;
			}
		}
	}
}

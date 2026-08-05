import { requestUrl } from "obsidian";

/**
 * 从 HTTPS URL 下载文件内容到 vault 路径。
 */
export async function downloadScript(
	url: string,
	dstPath: string,
	writeBinary: (path: string, data: ArrayBuffer) => Promise<void>,
): Promise<string | undefined> {
	try {
		const response = await requestUrl({ url });
		await writeBinary(dstPath, response.arrayBuffer);
		return dstPath;
	} catch (err) {
		console.warn(`[downloadScript] Failed to download ${url}:`, err);
		return undefined;
	}
}

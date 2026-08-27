/**
 * 预处理脚本构建/发布工具共享的常量与函数。
 *
 * 供 build-preprocess-scripts.mjs、generate-preprocess-index.mjs、
 * pin-registry.mjs 复用。保持纯 .mjs 以便 node 直接执行（不引入 TS 运行时依赖）。
 */

import { readFileSync } from "fs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** release asset 下载 URL 基地址（不含 tag 与文件名） */
export const RELEASE_ASSET_BASE_URL =
	"https://github.com/NateScarlet/obsidian-content-addressed-attachments/releases/download/";

/** release asset 名称统一加 preprocess- 前缀，避免与主插件资源混在一起 */
export function releaseAssetName(name) {
	return `preprocess-${name}`;
}

/** 计算二进制内容的 CID (v1, raw codec, SHA-256) */
export async function computeDataCID(data) {
	const digest = await sha256.digest(data);
	return CID.create(1, 0x55, digest).toString();
}

/** 计算文件的 CID (v1, raw codec, SHA-256) */
export async function computeCID(filePath) {
	return computeDataCID(readFileSync(filePath));
}

/** 去除 fragment 参数，得到基础 URL */
export function baseURL(scriptURL) {
	const hashIndex = scriptURL.indexOf("#");
	return hashIndex >= 0 ? scriptURL.slice(0, hashIndex) : scriptURL;
}

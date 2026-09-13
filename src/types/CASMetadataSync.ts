import type { CID } from "multiformats";

/**
 * 某 CID 落盘后可供索引使用的「最新已知事实」。
 * 仅含 CAS 落盘动作直接产生的元数据（save 的文件名/格式/大小）；
 * 副本/回收站状态不在其中——它不代表事实，由后台消费者自行基于磁盘探测重建。
 */
export interface CASMetadataDirty {
	cid: CID;
	filename?: string;
	format?: string;
	size?: number;
}

/**
 * 写侧同步端口：CAS 落盘事实后发布失效信号，由后台消费者据此按磁盘真相追平索引。
 * CAS 查询路径只此发布、立即返回，不等待索引落地。
 */
export interface CASMetadataSync {
	notifyChanged(signal: CASMetadataDirty): void;
}

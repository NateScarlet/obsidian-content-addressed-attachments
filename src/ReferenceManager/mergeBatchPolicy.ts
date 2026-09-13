/**
 * 引用查询请求合并策略（runInBatch 语义的纯函数部分）。
 *
 * 零积压零等待：请求到达时立即收割当前已到达的请求；没有其他请求等待
 * 就立即执行本批，不做最小等待窗口。上限（批大小）只为防积压场景下
 * 批无限膨胀与早到请求等待过久，是最上限而非最小等待。
 *
 * 参考：SQLite 缓存存储 runInBatch+loop 的收集循环——
 * 「没有立即可用的就停止以减少延迟，后续操作放到下一批」。
 */

/** 合并决策上下文：当前批的挂靠状态 */
export interface BatchState {
	/** 包括刚到达的这个请求在内的批内请求数 */
	pending: number;
}

/**
 * 是否立即执行当前批。
 * - 批内只有当前请求（无积压）→ 立即执行（零等待）；
 * - 达到批上限 → 立即执行（防膨胀）；
 * - 其余（有积压且未达上限）→ 不执行，让后续微任务到达的请求继续挂靠，
 *   收割在下一个微任务边界完成（IDB 事务过不了宏任务，注册窗口天然被截断）。
 */
export function shouldExecuteImmediately(
	state: BatchState,
	maxBatchSize: number,
): boolean {
	return state.pending <= 1 || state.pending >= maxBatchSize;
}

/**
 * 批归属键：合并只应用于相同验证语义的请求——
 * skipVerify 与默认验证的调用方对结果的正确性前提不同，不共享批。
 */
export function batchKeyOf(skipVerify: boolean): string {
	return skipVerify ? "skipVerify" : "verify";
}

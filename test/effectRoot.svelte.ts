/**
 * 让 node 侧单测能在独立 effect root 里创建依赖 $effect 的 runes 模块。
 * 仅测试使用，生产代码不需要。
 */
export function effectRoot<T>(create: () => T) {
	let result!: T;
	const destroy = $effect.root(() => {
		result = create();
	});
	return { result, destroy };
}

/**
 * 测试用的响应式盒子：让 node 侧单测能像组件里那样触发 $effect 重算。
 * 仅测试使用，生产代码不需要。
 */
export function reactiveBox<T>(initial: T) {
	let value = $state(initial);
	return {
		get value() {
			return value;
		},
		set value(next: T) {
			value = next;
		},
	};
}

import obsidian from "obsidian";

// obsidian 修改语言会要求重启，所以可以缓存
const cachedResult = (() => {
	if (typeof obsidian.getLanguage === "function") {
		return obsidian.getLanguage();
	}
	if (typeof navigator.languages === "object") {
		const zhIndex = navigator.languages.findIndex((i) =>
			i.startsWith("zh"),
		);
		const enIndex = navigator.languages.findIndex((i) =>
			i.startsWith("en"),
		);
		if (zhIndex >= 0 && (zhIndex < enIndex || enIndex < 0)) {
			return "zh";
		}
	}
	return "en";
})();

export default function getUILanguage(): string {
	return cachedResult;
}

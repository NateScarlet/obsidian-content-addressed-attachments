// obsidian 修改语言会要求重启，所以可以缓存
const cachedResult = (() => {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const obsidian = require("obsidian") as typeof import("obsidian");
		return obsidian.getLanguage();
	} catch {
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
	}
})();

export default function getUILanguage(): string {
	return cachedResult;
}

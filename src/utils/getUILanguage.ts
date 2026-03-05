import { getLanguage, moment } from "obsidian";

// obsidian 修改语言会要求重启，所以可以缓存
const cachedResult = (() => {
	if (typeof getLanguage === "function") {
		return getLanguage();
	}
	// moment 由 Obsidian 注入，能直接反映用户设置的界面语言
	if (moment.locale().startsWith("zh")) {
		return "zh";
	}
	return "en";
})();

export default function getUILanguage(): string {
	return cachedResult;
}

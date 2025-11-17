import getUILanguage from "./getUILanguage";

export default function defineLocales<const T>(messages: { zh: T; en: T }) {
	function t<K extends keyof T>(key: K): T[K] {
		switch (getUILanguage()) {
			case "zh-TW":
			case "zh":
				return messages.zh[key];
			default:
				return messages.en[key];
		}
	}
	return { t };
}

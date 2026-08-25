import getUILanguage from "./getUILanguage";

/** 中英双语文本 */
export interface LocalizedText {
	/** 英文文案 */
	en: string;
	/** 中文文案 */
	zh: string;
}

/** 按当前界面语言解析双语文本（语言映射与 defineLocales 一致） */
export default function localizedText(text: LocalizedText): string {
	switch (getUILanguage()) {
		case "zh":
		case "zh-TW":
			return text.zh;
		default:
			return text.en;
	}
}

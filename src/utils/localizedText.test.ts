import { describe, expect, it, vi } from "vitest";
import localizedText from "./localizedText";

// 界面语言由 obsidian 运行环境决定，测试中通过 mock 切换
const mocks = vi.hoisted(() => ({ uiLanguage: "en" }));

vi.mock("./getUILanguage", () => ({
	default: () => mocks.uiLanguage,
}));

describe("localizedText", () => {
	const text = { en: "Hello", zh: "你好" };

	it.each(["zh", "zh-TW"])(
		"returns zh text when UI language is %s",
		(lang) => {
			mocks.uiLanguage = lang;
			expect(localizedText(text)).toBe("你好");
		},
	);

	it.each(["en", "fr"])("returns en text when UI language is %s", (lang) => {
		mocks.uiLanguage = lang;
		expect(localizedText(text)).toBe("Hello");
	});
});

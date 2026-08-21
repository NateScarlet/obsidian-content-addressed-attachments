import { vi } from "vitest";

export class Notice {
	/** 已创建的实例记录，供测试断言通知内容与次数 */
	static instances: Notice[] = [];

	constructor(
		public message: string,
		public timeout?: number,
	) {
		Notice.instances.push(this);
	}
	hide() {}
}

export class TFile {
	path: string = "";
	extension: string = "";
}

export class App {}
export class Editor {}
export const requestUrl = vi.fn();
export function getLanguage() {
	return "en";
}

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
export function debounce<T extends unknown[]>(
	cb: (...args: T) => unknown,
	timeout = 0,
) {
	let timer: number | undefined;
	const debounced = (...args: T) => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = undefined;
			cb(...args);
		}, timeout);
	};
	debounced.cancel = () => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = undefined;
	};
	return debounced;
}
export function getLanguage() {
	return "en";
}
export async function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
	return await blob.arrayBuffer();
}

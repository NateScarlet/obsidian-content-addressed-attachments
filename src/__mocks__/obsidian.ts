import { vi } from "vitest";

export class Notice {
	constructor(
		public message: string,
		public timeout?: number,
	) {}
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

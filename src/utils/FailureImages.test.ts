import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ui = vi.hoisted(() => ({ language: "en" }));
vi.mock("./getUILanguage", () => ({
	default: () => ui.language,
}));

import FailureImages from "./FailureImages";
import {
	AllSourcesFailedError,
	DecryptionFailedError,
	InvalidContentIDError,
} from "../ResolveURLError";

describe("FailureImages", () => {
	let created: { url: string; blob: Blob }[];
	let revoked: string[];
	let createObjectURL: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		ui.language = "en";
		created = [];
		revoked = [];
		createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockImplementation((blob) => {
				const url = `blob:test/${created.length}`;
				created.push({ url, blob: blob as Blob });
				return url;
			});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
			revoked.push(url);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** 读取指定 blob URL 对应的 SVG 文本 */
	async function svgAt(url: string): Promise<string> {
		const entry = created.find((item) => item.url === url);
		if (!entry) throw new Error(`unknown blob url: ${url}`);
		return await entry.blob.text();
	}

	function createErrors() {
		return {
			allSources: new AllSourcesFailedError(
				2,
				new Error("Failed to fetch"),
			),
			invalidCID: new InvalidContentIDError("ipfs://bad"),
			decryption: new DecryptionFailedError(
				"blob.data",
				new Error("bad key"),
			),
		};
	}

	it("三类失败各自使用错误类型自带的文案，彼此可区分", async () => {
		const images = new FailureImages("File not found");
		const errors = createErrors();

		const urls = [
			images.forError(errors.allSources),
			images.forError(errors.invalidCID),
			images.forError(errors.decryption),
		];

		expect(new Set(urls).size).toBe(3);
		expect(await svgAt(urls[0])).toContain(
			"Failed to load: all sources unavailable",
		);
		expect(await svgAt(urls[1])).toContain(
			"Failed to load: invalid content ID",
		);
		expect(await svgAt(urls[2])).toContain("Failed to decrypt file");
	});

	it("中文界面读取错误类型自带的 zh 文案", async () => {
		ui.language = "zh";
		const images = new FailureImages("未找到文件");
		const { allSources } = createErrors();

		const url = images.forError(allSources);

		expect(await svgAt(url)).toContain("加载失败：所有来源均不可用");
	});

	it("非自定义错误回退到通用失败文案", async () => {
		const images = new FailureImages("File not found");

		const url = images.forError(new Error("boom"));

		const svg = await svgAt(url);
		expect(svg).toContain("Failed to load");
		expect(svg).not.toContain("boom");
	});

	it("同一文案复用同一个 blob URL", () => {
		const images = new FailureImages("File not found");

		const first = images.forError(new InvalidContentIDError("ipfs://a"));
		const second = images.forError(new InvalidContentIDError("ipfs://b"));

		expect(second).toBe(first);
		expect(createObjectURL).toHaveBeenCalledTimes(1);
	});

	it("notFound 使用构造时传入的文案", async () => {
		const images = new FailureImages("File not found");

		const url = images.notFound;

		expect(await svgAt(url)).toContain("File not found");
		expect(images.notFound).toBe(url);
	});

	it("dispose 释放全部创建的 blob URL", () => {
		const images = new FailureImages("File not found");
		expect(images.notFound).toBeTruthy();
		images.forError(new InvalidContentIDError("ipfs://a"));
		images.forError(new Error("boom"));

		images[Symbol.dispose]();

		expect(new Set(revoked)).toEqual(
			new Set(created.map((item) => item.url)),
		);
	});
});

import { describe, expect, it } from "vitest";
import {
	extractWrappedBackgroundURL,
	formatBackgroundImage,
} from "./wrappedBackgroundImage";

describe("wrappedBackgroundImage", () => {
	const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

	it("提取双引号 ipfs 伪装链接", () => {
		expect(
			extractWrappedBackgroundURL(`url("http:///ipfs://${cid}")`),
		).toBe(`ipfs://${cid}`);
	});

	it("提取单引号 ipfs 伪装链接", () => {
		expect(
			extractWrappedBackgroundURL(`url('http:///ipfs://${cid}')`),
		).toBe(`ipfs://${cid}`);
	});

	it("提取无引号 ipfs 伪装链接", () => {
		expect(extractWrappedBackgroundURL(`url(http:///ipfs://${cid})`)).toBe(
			`ipfs://${cid}`,
		);
	});

	it("提取 locked 伪装链接", () => {
		const locked = `internal.ipfs-locked:${cid},https://example.com/x.png`;
		expect(extractWrappedBackgroundURL(`url("http:///${locked}")`)).toBe(
			locked,
		);
	});

	it("普通 http(s) 背景图返回 undefined", () => {
		expect(
			extractWrappedBackgroundURL('url("https://example.com/x.png")'),
		).toBeUndefined();
	});

	it("伪装前缀但不是 IPFS 链接返回 undefined", () => {
		expect(
			extractWrappedBackgroundURL(
				'url("http:///https://example.com/x.png")',
			),
		).toBeUndefined();
	});

	it("非 url() 值返回 undefined", () => {
		expect(extractWrappedBackgroundURL("none")).toBeUndefined();
		expect(extractWrappedBackgroundURL("")).toBeUndefined();
	});

	it("格式化 background-image 值", () => {
		expect(formatBackgroundImage("app://local/a.png")).toBe(
			'url("app://local/a.png")',
		);
	});
});

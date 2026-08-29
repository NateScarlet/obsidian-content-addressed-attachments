import { describe, it, expect } from "vitest";
import { applyHeaderRules, headersToRecord } from "./applyHeaderRules";
import type { HeaderRule } from "../URLResolver";

describe("applyHeaderRules", () => {
	it("attaches headers to URLs matching the baseUrl prefix", () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]],
			},
		];
		const headers = new Headers();
		applyHeaderRules(
			"https://source.example.com/image.png",
			headers,
			rules,
		);
		expect(headers.get("Authorization")).toBe("Bearer token");
	});

	it("does not attach headers to non-matching URLs", () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]],
			},
		];
		const headers = new Headers();
		applyHeaderRules("https://other.com/image.png", headers, rules);
		expect(headers.get("Authorization")).toBeNull();
	});

	it("ignores rules with an empty baseUrl", () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "",
				headers: [["X-Token", "abc"]],
			},
		];
		const headers = new Headers();
		applyHeaderRules("https://any.com/image.png", headers, rules);
		expect(headers.get("X-Token")).toBeNull();
	});

	it("applies all matching rules in order", () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer global"]],
			},
			{
				baseUrl: "https://source.example.com/private",
				headers: [["Authorization", "Bearer private"]],
			},
		];
		const headers = new Headers();
		applyHeaderRules(
			"https://source.example.com/private/file",
			headers,
			rules,
		);
		// 后应用的规则覆盖同名 header
		expect(headers.get("Authorization")).toBe("Bearer private");
	});
});

describe("headersToRecord", () => {
	it("converts Headers to a plain record", () => {
		const headers = new Headers();
		headers.set("X-Token", "abc");
		expect(headersToRecord(headers)).toEqual({ "x-token": "abc" });
	});
});

import { describe, it, expect, vi } from "vitest";
import { applyHeaderRules, headersToRecord } from "./applyHeaderRules";
import type { SecretReader } from "./renderHeaderValue";
import type { HeaderRule } from "../URLResolver";

const noSecrets: SecretReader = () => undefined;

describe("applyHeaderRules", () => {
	it("attaches headers to URLs matching the baseUrl prefix", async () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]],
			},
		];
		const headers = new Headers();
		await applyHeaderRules(
			"https://source.example.com/image.png",
			headers,
			rules,
			noSecrets,
		);
		expect(headers.get("Authorization")).toBe("Bearer token");
	});

	it("does not attach headers to non-matching URLs", async () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer token"]],
			},
		];
		const headers = new Headers();
		await applyHeaderRules(
			"https://other.com/image.png",
			headers,
			rules,
			noSecrets,
		);
		expect(headers.get("Authorization")).toBeNull();
	});

	it("ignores rules with an empty baseUrl", async () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "",
				headers: [["X-Token", "abc"]],
			},
		];
		const headers = new Headers();
		await applyHeaderRules(
			"https://any.com/image.png",
			headers,
			rules,
			noSecrets,
		);
		expect(headers.get("X-Token")).toBeNull();
	});

	it("applies all matching rules in order", async () => {
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
		await applyHeaderRules(
			"https://source.example.com/private/file",
			headers,
			rules,
			noSecrets,
		);
		// 后应用的规则覆盖同名 header
		expect(headers.get("Authorization")).toBe("Bearer private");
	});

	it("renders secret placeholders in header values before setting them", async () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer {{secrets.token}}"]],
			},
		];
		const readSecret = vi.fn(() => "abc123");
		const headers = new Headers();
		await applyHeaderRules(
			"https://source.example.com/image.png",
			headers,
			rules,
			readSecret,
		);
		expect(headers.get("Authorization")).toBe("Bearer abc123");
	});

	it("does not read secrets for rules whose baseUrl does not match", async () => {
		const rules: HeaderRule[] = [
			{
				baseUrl: "https://source.example.com",
				headers: [["Authorization", "Bearer {{secrets.token}}"]],
			},
		];
		const readSecret = vi.fn(() => "abc123");
		const headers = new Headers();
		await applyHeaderRules(
			"https://other.com/image.png",
			headers,
			rules,
			readSecret,
		);
		expect(headers.get("Authorization")).toBeNull();
		expect(readSecret).not.toHaveBeenCalled();
	});
});

describe("headersToRecord", () => {
	it("converts Headers to a plain record", () => {
		const headers = new Headers();
		headers.set("X-Token", "abc");
		expect(headersToRecord(headers)).toEqual({ "x-token": "abc" });
	});
});

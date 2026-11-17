import { describe, it, expect, vi } from "vitest";
import renderHeaderValue, { type SecretReader } from "./renderHeaderValue";

/** 用键值表构造 mock 的 secret 读取实现，不依赖真实 Obsidian 环境。 */
const readerFrom =
	(secrets: Record<string, string | undefined>): SecretReader =>
	(id) =>
		secrets[id];

describe("renderHeaderValue", () => {
	it("replaces a secret placeholder with the stored value", async () => {
		expect(
			await renderHeaderValue(
				"Bearer {{secrets.token}}",
				readerFrom({ token: "s3cr3t" }),
			),
		).toBe("Bearer s3cr3t");
	});

	it("replaces every secret placeholder in one value", async () => {
		expect(
			await renderHeaderValue(
				"{{secrets.token}}:{{secrets.user}}",
				readerFrom({ token: "t", user: "u" }),
			),
		).toBe("t:u");
	});

	it("keeps the placeholder when the secret does not exist", async () => {
		expect(
			await renderHeaderValue(
				"Bearer {{secrets.missing}}",
				readerFrom({}),
			),
		).toBe("Bearer {{secrets.missing}}");
	});

	it("keeps the placeholder when reading throws", async () => {
		const readSecret: SecretReader = () => {
			throw new Error("keychain locked");
		};
		expect(
			await renderHeaderValue("Bearer {{secrets.token}}", readSecret),
		).toBe("Bearer {{secrets.token}}");
	});

	it("keeps the placeholder when the secret is null", async () => {
		const readSecret: SecretReader = () => null;
		expect(
			await renderHeaderValue("Bearer {{secrets.token}}", readSecret),
		).toBe("Bearer {{secrets.token}}");
	});

	it("replaces the placeholder with an empty string for an empty secret", async () => {
		expect(
			await renderHeaderValue(
				"Bearer {{secrets.token}}",
				readerFrom({ token: "" }),
			),
		).toBe("Bearer ");
	});

	it("does not escape or encode special characters in the secret value", async () => {
		expect(
			await renderHeaderValue(
				"Authorization: {{secrets.token}}",
				readerFrom({ token: "a+b/c=d&e" }),
			),
		).toBe("Authorization: a+b/c=d&e");
	});

	it("preserves other Mustache tags and surrounding text", async () => {
		expect(
			await renderHeaderValue(
				"{{cid}} prefix {{secrets.token}} suffix {{#flag}}x{{/flag}}",
				readerFrom({ token: "t" }),
			),
		).toBe("{{cid}} prefix t suffix {{#flag}}x{{/flag}}");
	});

	it("accepts secret IDs containing dashes and digits", async () => {
		expect(
			await renderHeaderValue(
				"{{secrets.my-token-2}}",
				readerFrom({ "my-token-2": "v" }),
			),
		).toBe("v");
	});

	it("does not match dotted IDs", async () => {
		const readSecret = vi.fn(() => "v");
		expect(await renderHeaderValue("{{secrets.a.b}}", readSecret)).toBe(
			"{{secrets.a.b}}",
		);
		expect(readSecret).not.toHaveBeenCalled();
	});

	it("leaves values without placeholders untouched and reads nothing", async () => {
		const readSecret = vi.fn(() => "v");
		const value = "Bearer plain-token {{cid}}";
		expect(await renderHeaderValue(value, readSecret)).toBe(value);
		expect(readSecret).not.toHaveBeenCalled();
	});

	it("reads secrets fresh on every call so rotation takes effect", async () => {
		let current = "old";
		const readSecret: SecretReader = () => current;
		expect(await renderHeaderValue("{{secrets.token}}", readSecret)).toBe(
			"old",
		);
		current = "new";
		expect(await renderHeaderValue("{{secrets.token}}", readSecret)).toBe(
			"new",
		);
	});
});

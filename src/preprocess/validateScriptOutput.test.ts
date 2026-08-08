import { describe, it, expect } from "vitest";
import { assertScriptOutput } from "./validateScriptOutput";

const scriptURL = "scripts/transform.js";

describe("assertScriptOutput", () => {
	it("accepts a valid output", () => {
		expect(() =>
			assertScriptOutput(
				{
					data: new ArrayBuffer(4),
					mimeType: "image/avif",
					filename: "test.avif",
				},
				scriptURL,
			),
		).not.toThrow();
	});

	it("accepts output without mimeType or filename", () => {
		expect(() =>
			assertScriptOutput({ data: new ArrayBuffer(4) }, scriptURL),
		).not.toThrow();
	});

	it("throws when result is not an object", () => {
		for (const invalid of [null, undefined, "data", 42, true, ["data"]]) {
			expect(() => assertScriptOutput(invalid, scriptURL)).toThrow(
				"expected an object",
			);
		}
	});

	it("throws when data is missing", () => {
		expect(() =>
			assertScriptOutput(
				{ mimeType: "image/avif", filename: "test.avif" },
				scriptURL,
			),
		).toThrow("'data' must be an ArrayBuffer");
	});

	it("throws when data is not an ArrayBuffer", () => {
		for (const invalid of ["data", new Blob([]), new Uint8Array(4)]) {
			expect(() =>
				assertScriptOutput(
					{ data: invalid, mimeType: "image/avif" },
					scriptURL,
				),
			).toThrow("'data' must be an ArrayBuffer");
		}
	});

	it("throws when mimeType is not a string", () => {
		expect(() =>
			assertScriptOutput(
				{ data: new ArrayBuffer(4), mimeType: 42 },
				scriptURL,
			),
		).toThrow("'mimeType' must be a string");
	});

	it("throws when filename is not a string", () => {
		expect(() =>
			assertScriptOutput(
				{ data: new ArrayBuffer(4), filename: 42 },
				scriptURL,
			),
		).toThrow("'filename' must be a string");
	});

	it("includes the script URL in the error message", () => {
		expect(() =>
			assertScriptOutput({ mimeType: "image/avif" }, "custom/script.js"),
		).toThrow("custom/script.js");
	});
});

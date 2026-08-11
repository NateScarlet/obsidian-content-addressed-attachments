import { describe, it, expect } from "vitest";
import { assertScriptOutput } from "./validateScriptOutput";

const scriptURL = "scripts/transform.js";
const validInput = { filename: "test.png" };
const emptyFilenameInput = { filename: "" };

describe("assertScriptOutput", () => {
	it("accepts a valid output", () => {
		expect(() =>
			assertScriptOutput(
				{
					data: new ArrayBuffer(4),
					mimeType: "image/avif",
					filename: "test.avif",
				},
				validInput,
				scriptURL,
			),
		).not.toThrow();
	});

	it("accepts an empty output filename when the input filename is empty", () => {
		expect(() =>
			assertScriptOutput(
				{
					data: new ArrayBuffer(4),
					mimeType: "image/avif",
					filename: "",
				},
				emptyFilenameInput,
				scriptURL,
			),
		).not.toThrow();
	});

	it("throws when mimeType is missing or empty", () => {
		for (const output of [
			{ data: new ArrayBuffer(4), filename: "test.avif" },
			{ data: new ArrayBuffer(4), mimeType: "", filename: "test.avif" },
		]) {
			expect(() =>
				assertScriptOutput(output, validInput, scriptURL),
			).toThrow("'mimeType' must be a non-empty string");
		}
	});

	it("throws when filename is missing or empty", () => {
		for (const output of [
			{ data: new ArrayBuffer(4), mimeType: "image/avif" },
			{ data: new ArrayBuffer(4), mimeType: "image/avif", filename: "" },
		]) {
			expect(() =>
				assertScriptOutput(output, validInput, scriptURL),
			).toThrow("'filename' must be a non-empty string");
		}
	});

	it("throws when result is not an object", () => {
		for (const invalid of [null, undefined, "data", 42, true, ["data"]]) {
			expect(() =>
				assertScriptOutput(invalid, validInput, scriptURL),
			).toThrow("expected an object");
		}
	});

	it("throws when data is missing", () => {
		expect(() =>
			assertScriptOutput(
				{ mimeType: "image/avif", filename: "test.avif" },
				validInput,
				scriptURL,
			),
		).toThrow("'data' must be an ArrayBuffer");
	});

	it("throws when data is not an ArrayBuffer", () => {
		for (const invalid of ["data", new Blob([]), new Uint8Array(4)]) {
			expect(() =>
				assertScriptOutput(
					{ data: invalid, mimeType: "image/avif" },
					validInput,
					scriptURL,
				),
			).toThrow("'data' must be an ArrayBuffer");
		}
	});

	it("throws when mimeType is not a string", () => {
		expect(() =>
			assertScriptOutput(
				{ data: new ArrayBuffer(4), mimeType: 42 },
				validInput,
				scriptURL,
			),
		).toThrow("'mimeType' must be a non-empty string");
	});

	it("throws when filename is not a string", () => {
		expect(() =>
			assertScriptOutput(
				{
					data: new ArrayBuffer(4),
					mimeType: "image/avif",
					filename: 42,
				},
				validInput,
				scriptURL,
			),
		).toThrow("'filename' must be a non-empty string");
	});

	it("includes the script URL in the error message", () => {
		expect(() =>
			assertScriptOutput(
				{ mimeType: "image/avif" },
				validInput,
				"custom/script.js",
			),
		).toThrow("custom/script.js");
	});
});

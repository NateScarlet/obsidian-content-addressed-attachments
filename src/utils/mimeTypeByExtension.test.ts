import { describe, it, expect } from "vitest";
import mimeTypeByExtension, { effectiveMimeType } from "./mimeTypeByExtension";

describe("mimeTypeByExtension", () => {
	it("returns image/heic for .heic extension", () => {
		expect(mimeTypeByExtension(".heic")).toBe("image/heic");
		expect(mimeTypeByExtension(".HEIC")).toBe("image/heic");
	});

	it("returns image/heif for .heif extension", () => {
		expect(mimeTypeByExtension(".heif")).toBe("image/heif");
		expect(mimeTypeByExtension(".HEIF")).toBe("image/heif");
	});

	it("returns image/png for .png extension", () => {
		expect(mimeTypeByExtension(".png")).toBe("image/png");
	});

	it("returns application/octet-stream for unknown extensions", () => {
		expect(mimeTypeByExtension(".unknown")).toBe(
			"application/octet-stream",
		);
	});
});

describe("effectiveMimeType", () => {
	it("keeps an existing concrete mime type as-is", () => {
		expect(effectiveMimeType("image/webp", "photo.heic")).toBe(
			"image/webp",
		);
	});

	it("infers from filename when mime type is empty", () => {
		expect(effectiveMimeType("", "photo.heic")).toBe("image/heic");
	});

	it("infers from filename when mime type is generic octet-stream", () => {
		expect(effectiveMimeType("application/octet-stream", "photo.png")).toBe(
			"image/png",
		);
	});

	it("keeps the original value when extension is unknown or missing", () => {
		expect(
			effectiveMimeType("application/octet-stream", "photo.unknown"),
		).toBe("application/octet-stream");
		expect(effectiveMimeType("", "no-extension")).toBe("");
	});
});

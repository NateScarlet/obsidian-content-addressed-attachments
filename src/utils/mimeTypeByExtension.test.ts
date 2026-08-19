import { describe, it, expect } from "vitest";
import mimeTypeByExtension from "./mimeTypeByExtension";

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
		expect(mimeTypeByExtension(".unknown")).toBe("application/octet-stream");
	});
});

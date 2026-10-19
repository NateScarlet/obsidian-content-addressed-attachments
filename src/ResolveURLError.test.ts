import { describe, it, expect } from "vitest";
import ResolveURLError, {
	AllSourcesFailedError,
	DecryptionFailedError,
	InvalidContentIDError,
} from "./ResolveURLError";

describe("ResolveURLError", () => {
	it("AllSourcesFailedError 携带来源数量与首个底层原因", () => {
		const reason = new TypeError("Failed to fetch");
		const error = new AllSourcesFailedError(3, reason);

		expect(error).toBeInstanceOf(ResolveURLError);
		expect(error.name).toBe("AllSourcesFailedError");
		expect(error.sourceCount).toBe(3);
		expect(error.reason).toBe(reason);
		expect(error.message).toContain("Failed to fetch");
	});

	it("InvalidContentIDError 携带原始标识与底层原因", () => {
		const reason = new Error("Incorrect length");
		const error = new InvalidContentIDError("ipfs://bad", reason);

		expect(error).toBeInstanceOf(ResolveURLError);
		expect(error.name).toBe("InvalidContentIDError");
		expect(error.identifier).toBe("ipfs://bad");
		expect(error.reason).toBe(reason);
		expect(error.message).toContain("ipfs://bad");
	});

	it("DecryptionFailedError 携带文件路径与底层原因", () => {
		const reason = new Error("bad key");
		const error = new DecryptionFailedError("blob.data", reason);

		expect(error).toBeInstanceOf(ResolveURLError);
		expect(error.name).toBe("DecryptionFailedError");
		expect(error.filePath).toBe("blob.data");
		expect(error.reason).toBe(reason);
		expect(error.message).toContain("blob.data");
	});

	it("每个错误类型都自带中英双语展示文案", () => {
		const errors = [
			new AllSourcesFailedError(1, new Error("x")),
			new InvalidContentIDError("ipfs://bad"),
			new DecryptionFailedError("blob.data", new Error("x")),
		];

		for (const error of errors) {
			expect(error.display.en).toBeTruthy();
			expect(error.display.zh).toBeTruthy();
			expect(error.display.en).not.toBe(error.display.zh);
		}
	});
});

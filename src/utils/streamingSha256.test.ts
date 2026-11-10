import { describe, expect, it } from "vitest";
import { sha256 } from "multiformats/hashes/sha2";
import StreamingSha256 from "./streamingSha256";

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 用一次性 SHA-256 计算期望值，和增量实现对比（取裸摘要，不含 multihash 前缀） */
async function expectedHex(bytes: Uint8Array): Promise<string> {
	const digest = await sha256.digest(bytes);
	return toHex(digest.digest);
}

describe("StreamingSha256", () => {
	it("matches known digests for the standard short vectors", () => {
		const vectors = [
			"",
			"abc",
			"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		];
		const expected = [
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		];
		for (const [index, text] of vectors.entries()) {
			const hasher = new StreamingSha256();
			hasher.update(new TextEncoder().encode(text));
			expect(toHex(hasher.digest())).toBe(expected[index]);
		}
	});

	it("gives the same digest regardless of how the input is split", async () => {
		const data = new Uint8Array(1024 * 1024 + 17);
		for (let i = 0; i < data.length; i++) {
			data[i] = (i * 31 + 7) % 256;
		}
		const expected = await expectedHex(data);

		// 覆盖块边界附近、整块多倍与超过总长（含空块）三种切分
		for (const chunkSize of [63, 64, 65, 1024, 65536, data.length + 1]) {
			const hasher = new StreamingSha256();
			for (let offset = 0; offset < data.length; offset += chunkSize) {
				hasher.update(data.subarray(offset, offset + chunkSize));
			}
			expect(toHex(hasher.digest())).toBe(expected);
		}

		// 逐字节摄取：每次调用都跨越缓冲区状态
		const small = data.subarray(0, 2000);
		const byteWise = new StreamingSha256();
		for (let i = 0; i < small.length; i++) {
			byteWise.update(small.subarray(i, i + 1));
		}
		expect(toHex(byteWise.digest())).toBe(await expectedHex(small));
	});

	it("does not mutate or retain the input chunks", async () => {
		const first = new Uint8Array([1, 2, 3, 4]);
		const second = new Uint8Array([5, 6, 7]);
		const hasher = new StreamingSha256();
		hasher.update(first);
		hasher.update(second);
		// 调用方复用缓冲区不应影响已经摄入的数据
		first.fill(0);
		second.fill(0);

		const expected = await expectedHex(
			new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
		);
		expect(toHex(hasher.digest())).toBe(expected);
	});

	it("rejects updates after the digest was taken", () => {
		const hasher = new StreamingSha256();
		hasher.update(new Uint8Array([1]));
		hasher.digest();
		expect(() => hasher.update(new Uint8Array([2]))).toThrow();
		expect(() => hasher.digest()).toThrow();
	});
});

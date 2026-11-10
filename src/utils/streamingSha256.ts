/**
 * 增量 SHA-256。
 *
 * 流式下载需要在数据分块到达时同步计算摘要，而 Web Crypto 的
 * `crypto.subtle.digest` 只接受完整缓冲区（等价于把整个对象读进内存），
 * multiformats 的 hasher 同样是整块接口。因此这里实现一个只保存 64 字节
 * 块状态与 8 个中间变量的增量版本，使内存占用与分块大小同阶。
 */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 32 位循环右移 */
function rotr(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

export default class StreamingSha256 {
	private readonly h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	]);
	private readonly block = new Uint8Array(64);
	private blockLength = 0;
	private totalBytes = 0;
	private readonly schedule = new Uint32Array(64);
	private finished = false;

	/** 摄入一段数据；可以先分多次调用，最后再取摘要 */
	update(data: Uint8Array): void {
		if (this.finished) {
			throw new Error("StreamingSha256: update after digest");
		}
		this.totalBytes += data.byteLength;
		let offset = 0;

		// 先补齐上次留下的半个块
		if (this.blockLength > 0) {
			const take = Math.min(64 - this.blockLength, data.byteLength);
			this.block.set(data.subarray(0, take), this.blockLength);
			this.blockLength += take;
			offset = take;
			if (this.blockLength < 64) {
				return;
			}
			this.compress(this.block, 0);
			this.blockLength = 0;
		}

		// 整块直接压缩，不复制
		for (; offset + 64 <= data.byteLength; offset += 64) {
			this.compress(data, offset);
		}

		// 不足一块的尾巴留在缓冲区，等待下次调用
		if (offset < data.byteLength) {
			this.block.set(data.subarray(offset), 0);
			this.blockLength = data.byteLength - offset;
		}
	}

	/** 结束计算并返回 32 字节摘要；只能调用一次 */
	digest(): Uint8Array {
		if (this.finished) {
			throw new Error("StreamingSha256: digest called twice");
		}
		this.finished = true;

		// 补位：0x80 + 若干 0 + 64 位大端比特长度
		const padding = this.blockLength < 56 ? 64 : 128;
		const tail = new Uint8Array(padding);
		tail.set(this.block.subarray(0, this.blockLength));
		tail[this.blockLength] = 0x80;
		const view = new DataView(tail.buffer);
		const bits = this.totalBytes * 8;
		view.setUint32(padding - 8, Math.floor(bits / 0x1_0000_0000));
		view.setUint32(padding - 4, bits % 0x1_0000_0000);
		this.compress(tail, 0);
		if (padding === 128) {
			this.compress(tail, 64);
		}

		const digest = new Uint8Array(32);
		const digestView = new DataView(digest.buffer);
		for (let i = 0; i < 8; i++) {
			digestView.setUint32(i * 4, this.h[i]);
		}
		return digest;
	}

	/** 压缩一个 64 字节块 */
	private compress(bytes: Uint8Array, offset: number): void {
		const w = this.schedule;
		for (let i = 0; i < 16; i++) {
			const j = offset + i * 4;
			w[i] =
				(bytes[j] << 24) |
				(bytes[j + 1] << 16) |
				(bytes[j + 2] << 8) |
				bytes[j + 3];
		}
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15];
			const y = w[i - 2];
			const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
			const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let a = this.h[0];
		let b = this.h[1];
		let c = this.h[2];
		let d = this.h[3];
		let e = this.h[4];
		let f = this.h[5];
		let g = this.h[6];
		let h = this.h[7];

		for (let i = 0; i < 64; i++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + maj) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}

		this.h[0] = (this.h[0] + a) >>> 0;
		this.h[1] = (this.h[1] + b) >>> 0;
		this.h[2] = (this.h[2] + c) >>> 0;
		this.h[3] = (this.h[3] + d) >>> 0;
		this.h[4] = (this.h[4] + e) >>> 0;
		this.h[5] = (this.h[5] + f) >>> 0;
		this.h[6] = (this.h[6] + g) >>> 0;
		this.h[7] = (this.h[7] + h) >>> 0;
	}
}

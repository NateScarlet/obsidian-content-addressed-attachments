import { describe, it, expect, vi, beforeEach } from "vitest";
import { URLResolver } from "./URLResolver";
import { CID } from "multiformats/cid";
import { ENCRYPTED_FORMAT } from "./lib/encryption/types";
import { requestUrl, type App } from "obsidian";
import type { CAS } from "./types/CAS";
import type EncryptionService from "./lib/encryption/EncryptionService";
import { getDefaultSettings, type Settings } from "./settings";

describe("URLResolver", () => {
	const dummyCIDStr =
		"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
	const dummyCID = CID.parse(dummyCIDStr);

	let mockApp: App;
	let mockCas: CAS;
	let mockEncryptionService: EncryptionService;
	let settings: Settings;
	let resolver: URLResolver;

	beforeEach(() => {
		mockApp = {
			vault: {
				adapter: {
					getResourcePath: vi.fn(
						(path: string) => `app://local/${path}`,
					),
					readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
					exists: vi.fn().mockResolvedValue(false),
				},
			},
		} as unknown as App;

		mockCas = {
			load: vi.fn().mockResolvedValue(undefined),
			lookup: vi.fn().mockImplementation(async function* () {}),
			save: vi.fn().mockResolvedValue({ cid: dummyCID, didCreate: true }),
			formatRelPath: vi.fn((cid: CID) => `${cid.toString()}.data`),
			formatNormalizePath: vi.fn(
				(dir: string, cid: CID) => `${dir}/${cid.toString()}`,
			),
		} as unknown as CAS;

		mockEncryptionService = {
			ensureDecrypted: vi.fn().mockResolvedValue({
				data: new ArrayBuffer(8),
				mimeType: "image/png",
				layers: [{ header: {} }],
				toBlob: () => new Blob(["test"], { type: "image/png" }),
			}),
		} as unknown as EncryptionService;

		settings = {
			...getDefaultSettings(),
			gateways: [
				{
					name: "test-gw",
					urlTemplate:
						"https://gateway.com/ipfs/{{cid}}{{{url.pathname}}}",
					headers: [],
					enabled: true,
				},
			],
		};

		resolver = new URLResolver(
			mockApp,
			mockCas,
			() => settings,
			mockEncryptionService,
		);
	});

	it("decrypts downloaded encrypted file when resolving an IPFS URL", async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": ENCRYPTED_FORMAT },
			arrayBuffer: new ArrayBuffer(16),
			json: {},
			text: "",
		});

		const rawURL = `ipfs://${dummyCIDStr}?format=${encodeURIComponent(ENCRYPTED_FORMAT)}`;
		const result = await resolver.resolveURL(rawURL);

		expect(result).toBeDefined();
		// Should have called ensureDecrypted on the downloaded payload
		// eslint-disable-next-line @typescript-eslint/unbound-method
		expect(mockEncryptionService.ensureDecrypted).toHaveBeenCalled();
		// Result URL should be a blob URL, NOT the raw ciphertext app:// URL
		expect(result?.url).toMatch(/^blob:/);
	});
});

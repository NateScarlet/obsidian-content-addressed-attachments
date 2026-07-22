import {
	Notice,
	requestUrl,
	type App,
	type TFile,
	type Editor,
} from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import parseIPFSLink from "#src/utils/parseIPFSLink";
import findIPFSLinks from "#src/utils/findIPFSLinks";
import formatMarkdownLink from "#src/utils/formatMarkdownLink";
import defineLocales from "#src/utils/defineLocales";

const { t } = defineLocales({
	en: {
		encryptLink: "Encrypt this link",
		decryptLink: "Decrypt this link",
		encryptLinkSuccess: "Link encrypted",
		decryptLinkSuccess: "Link decrypted",
		noKeyAvailable:
			"No encryption key available. Create one in settings first.",
	},
	zh: {
		encryptLink: "加密此链接",
		decryptLink: "解密此链接",
		encryptLinkSuccess: "链接已加密",
		decryptLinkSuccess: "链接已解密",
		noKeyAvailable: "没有可用加密密钥。请在设置中先创建密钥。",
	},
});

interface LinkPos {
	start: number;
	end: number;
	text: string;
}

function findLinkAtOffset(
	content: string,
	offset: number,
): LinkPos | undefined {
	const links = Array.from(findIPFSLinks(content));
	for (const link of links) {
		const [start, end] = link.pos;
		if (start <= offset && offset <= end) {
			return { start, end, text: content.slice(start, end) };
		}
	}
}

async function loadFileContent(
	app: App,
	cas: CAS,
	cidStr: string,
): Promise<
	{ buffer: ArrayBuffer; filename: string; format: string } | undefined
> {
	const cid = CID.parse(cidStr);
	const match = await cas.load(cid);
	if (match) {
		const buffer = await app.vault.adapter.readBinary(match.normalizedPath);
		const filename = match.normalizedPath.split("/").pop() ?? "";
		return { buffer, filename, format: "" };
	}
	const gateways = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
	for (const gw of gateways) {
		try {
			const url = `${gw}${cidStr}`;
			const resp = await requestUrl({ url, throw: false });
			if (resp.status === 200) {
				const ct = resp.headers["content-type"] ?? "";
				return {
					buffer: resp.arrayBuffer,
					filename: cidStr,
					format: ct,
				};
			}
		} catch {
			/* next */
		}
	}
}

export async function encryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	dir: string,
	editor: Editor,
	linkStart: number,
	linkEnd: number,
	linkText: string,
	notePath?: string,
): Promise<void> {
	const fingerprint =
		(notePath
			? await encryptionService.resolveKeyForNotePath(notePath)
			: undefined) ??
		(await encryptionService.keyManager.getPrimaryKey())?.fingerprint;
	if (!fingerprint) {
		new Notice(t("noKeyAvailable"));
		return;
	}
	const parsed = parseIPFSLink(linkText);
	if (!parsed || parsed.format === ENCRYPTED_FORMAT) return;

	const content = await loadFileContent(app, cas, parsed.cid.toString());
	if (!content) {
		new Notice("File not found");
		return;
	}

	const file = new File(
		[new Blob([content.buffer])],
		parsed.filename || content.filename,
		{
			type: parsed.format || content.format || "application/octet-stream",
		},
	);
	const { encryptedFile } = await encryptionService.encryptFile(
		fingerprint,
		file,
	);
	const { cid: newCid } = await cas.save(dir, encryptedFile);
	const newLink = formatMarkdownLink(encryptedFile, newCid, true);

	editor.replaceRange(
		newLink,
		editor.offsetToPos(linkStart),
		editor.offsetToPos(linkEnd),
	);
	new Notice(t("encryptLinkSuccess"));
}

export async function decryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	dir: string,
	editor: Editor,
	linkStart: number,
	linkEnd: number,
	linkText: string,
): Promise<void> {
	const parsed = parseIPFSLink(linkText);
	if (!parsed || parsed.format !== ENCRYPTED_FORMAT) return;

	const content = await loadFileContent(app, cas, parsed.cid.toString());
	if (!content) {
		new Notice("File not found");
		return;
	}

	const decrypted = await encryptionService.decryptFile(content.buffer);
	if (!decrypted) {
		new Notice("Not an encrypted file");
		return;
	}

	const file = new File(
		[new Blob([decrypted.data])],
		parsed.filename || "file",
		{ type: decrypted.mimeType },
	);
	const { cid: newCid } = await cas.save(dir, file);
	const newLink = formatMarkdownLink(file, newCid, false);

	editor.replaceRange(
		newLink,
		editor.offsetToPos(linkStart),
		editor.offsetToPos(linkEnd),
	);
	new Notice(t("decryptLinkSuccess"));
}

export function findLinkAtPos(
	content: string,
	offset: number,
): LinkPos | undefined {
	return findLinkAtOffset(content, offset);
}

export function isEncryptedLink(linkText: string): boolean {
	const parsed = parseIPFSLink(linkText);
	return parsed?.format === ENCRYPTED_FORMAT;
}

export async function encryptNote(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	file: TFile,
	keyFingerprint: string,
	dir: string,
): Promise<number> {
	let content = await app.vault.read(file);
	const links = Array.from(findIPFSLinks(content));
	let count = 0;

	for (const link of links) {
		try {
			const linkText = content.slice(link.pos[0], link.pos[1]);
			const parsed = parseIPFSLink(linkText);
			if (!parsed || parsed.format === ENCRYPTED_FORMAT) continue;

			const result = await loadFileContent(
				app,
				cas,
				parsed.cid.toString(),
			);
			if (!result) continue;

			const origFile = new File(
				[new Blob([result.buffer])],
				parsed.filename || result.filename,
				{
					type:
						parsed.format ||
						result.format ||
						"application/octet-stream",
				},
			);
			const { encryptedFile } = await encryptionService.encryptFile(
				keyFingerprint,
				origFile,
			);
			const { cid: newCid } = await cas.save(dir, encryptedFile);
			const newLink = formatMarkdownLink(encryptedFile, newCid, true);

			content =
				content.slice(0, link.pos[0]) +
				newLink +
				content.slice(link.pos[1]);
			count++;
		} catch (err) {
			console.error("Failed to encrypt link:", link, err);
		}
	}

	if (count > 0) {
		await app.vault.modify(file, content);
	}
	return count;
}

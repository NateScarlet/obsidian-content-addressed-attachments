import { Notice, type App, type TFile, type Editor } from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import type { EncryptPathPolicy } from "#src/lib/encryption/EncryptPathPolicy";
import type { URLResolver } from "#src/URLResolver";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import findIPFSLinks from "#src/utils/findIPFSLinks";
import { IPFSLink } from "#src/utils/IPFSLink";
import { VaultLinkTransformer } from "#src/utils/VaultLinkTransformer";
import defineLocales from "#src/utils/defineLocales";
import type { KeyManager } from "#src/lib/encryption/KeyManager";

import type ReferenceManager from "#src/ReferenceManager";

const { t } = defineLocales({
	en: {
		encryptLink: "Encrypt this link",
		decryptLink: "Decrypt this link",
		encryptLinkSuccess: "Link encrypted",
		decryptLinkSuccess: "Link decrypted",
		noKeyAvailable:
			"No encryption key available. Create one in settings first.",
		fileStillReferenced: (paths: string) =>
			`Source file is still referenced in other notes (${paths}), skipping trash.`,
	},
	zh: {
		encryptLink: "加密此链接",
		decryptLink: "解密此链接",
		encryptLinkSuccess: "链接已加密",
		decryptLinkSuccess: "链接已解密",
		noKeyAvailable: "没有可用加密密钥。请在设置中先创建密钥。",
		fileStillReferenced: (paths: string) =>
			`原文件仍被其他笔记引用（${paths}），跳过清理。`,
	},
});

interface LinkPos {
	start: number;
	end: number;
	text: string;
	isEmbed: boolean;
}

async function trashIfUnreferenced(
	cas: CAS,
	referenceManager: ReferenceManager,
	cid: CID,
	currentNotePath?: string,
): Promise<void> {
	const referencingFiles: string[] = [];
	for await (const path of referenceManager.findFilePath(cid, undefined)) {
		if (path !== currentNotePath) {
			referencingFiles.push(path);
		}
	}

	if (referencingFiles.length > 0) {
		new Notice(t("fileStillReferenced")(referencingFiles.join(", ")));
		return;
	}

	await cas.trash(cid);
}

async function loadFileContent(
	app: App,
	cas: CAS,
	cidStr: string,
	urlResolver: URLResolver,
	fallbackFilename?: string,
): Promise<
	{ buffer: ArrayBuffer; filename: string; format: string } | undefined
> {
	const cid = CID.parse(cidStr);

	const match = await cas.load(cid);
	if (match) {
		const buffer = await app.vault.adapter.readBinary(match.normalizedPath);
		const filename = fallbackFilename ?? "";
		return { buffer, filename, format: "" };
	}

	const rawURL = `ipfs://${cidStr}`;
	const resolved = await urlResolver.resolveURL(rawURL);
	if (resolved?.path) {
		const buffer = await app.vault.adapter.readBinary(resolved.path);
		const filename = fallbackFilename ?? "";
		return { buffer, filename, format: "" };
	}
}

export async function encryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	urlResolver: URLResolver,
	referenceManager: ReferenceManager,
	dir: string,
	editor: Editor,
	linkStart: number,
	linkEnd: number,
	linkText: string,
	notePath?: string,
	keyManager?: KeyManager,
	encryptPathPolicy?: EncryptPathPolicy,
): Promise<void> {
	const km = keyManager ?? encryptionService.keyManager;
	const fingerprint =
		(notePath && encryptPathPolicy
			? await encryptPathPolicy.resolveKey(notePath)
			: undefined) ?? (await km.getPrimaryKey())?.fingerprint;
	if (!fingerprint) {
		new Notice(t("noKeyAvailable"));
		return;
	}
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format === ENCRYPTED_FORMAT) return;

	const content = await loadFileContent(
		app,
		cas,
		parsed.cid.toString(),
		urlResolver,
		parsed.filename,
	);
	if (!content) {
		new Notice("File not found");
		return;
	}

	const file = new File([new Blob([content.buffer])], content.filename, {
		type: parsed.format || content.format || "application/octet-stream",
	});
	let encryptedFile: File;
	try {
		encryptedFile = await encryptionService.ensureEncrypted(
			file,
			fingerprint,
		);
	} catch {
		new Notice(t("noKeyAvailable"));
		return;
	}

	const { cid: newCid } = await cas.save(dir, encryptedFile);
	if (!newCid.equals(parsed.cid)) {
		await trashIfUnreferenced(cas, referenceManager, parsed.cid, notePath);
	}
	const newURL = new IPFSLink({
		cid: newCid,
		filename: encryptedFile.name,
		format: ENCRYPTED_FORMAT,
	}).toURL();

	editor.replaceRange(
		newURL,
		editor.offsetToPos(linkStart),
		editor.offsetToPos(linkEnd),
	);
	new Notice(t("encryptLinkSuccess"));
}

export async function decryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	urlResolver: URLResolver,
	referenceManager: ReferenceManager,
	dir: string,
	editor: Editor,
	linkStart: number,
	linkEnd: number,
	linkText: string,
	notePath?: string,
): Promise<void> {
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format !== ENCRYPTED_FORMAT) return;

	const content = await loadFileContent(
		app,
		cas,
		parsed.cid.toString(),
		urlResolver,
		parsed.filename,
	);
	if (!content) {
		new Notice("File not found");
		return;
	}

	const decrypted = await encryptionService.ensureDecrypted(content.buffer);
	if (!decrypted || !decrypted.wasEncrypted) {
		new Notice("Not an encrypted file");
		return;
	}

	const file = new File([decrypted.toBlob()], content.filename || "file", {
		type: decrypted.mimeType,
	});
	const { cid: newCid } = await cas.save(dir, file);
	if (!newCid.equals(parsed.cid)) {
		await trashIfUnreferenced(cas, referenceManager, parsed.cid, notePath);
	}
	const newURL = new IPFSLink({
		cid: newCid,
		filename: file.name,
		format: file.type,
	}).toURL();

	editor.replaceRange(
		newURL,
		editor.offsetToPos(linkStart),
		editor.offsetToPos(linkEnd),
	);
	new Notice(t("decryptLinkSuccess"));
}

export function findLinkAtPos(
	content: string,
	offset: number,
): LinkPos | undefined {
	for (const match of findIPFSLinks(content)) {
		if (offset >= match.pos[0] && offset <= match.pos[1]) {
			return {
				start: match.pos[0],
				end: match.pos[1],
				text: content.slice(match.pos[0], match.pos[1]),
				isEmbed: match.isEmbed,
			};
		}
	}
}

export function isEncryptedLink(linkText: string): boolean {
	const parsed = IPFSLink.parse(linkText);
	return parsed?.format === ENCRYPTED_FORMAT;
}

export async function encryptNote(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	urlResolver: URLResolver,
	referenceManager: ReferenceManager,
	file: TFile,
	keyFingerprint: string,
	dir: string,
	keyManager?: KeyManager,
	encryptPathPolicy?: EncryptPathPolicy,
): Promise<number> {
	const km = keyManager ?? encryptionService.keyManager;
	const fp =
		(keyFingerprint
			? await km
					.getKeyForEncrypt(keyFingerprint)
					.then((k) => (k ? keyFingerprint : undefined))
			: undefined) ??
		(encryptPathPolicy
			? await encryptPathPolicy.resolveKey(file.path)
			: undefined) ??
		(await km.getPrimaryKey())?.fingerprint;

	if (!fp) return 0;

	const transformer = new VaultLinkTransformer(app);
	return transformer.transformFile(file, async (_match, linkText) => {
		const parsed = IPFSLink.parse(linkText);
		if (!parsed || parsed.format === ENCRYPTED_FORMAT) return undefined;

		const result = await loadFileContent(
			app,
			cas,
			parsed.cid.toString(),
			urlResolver,
			parsed.filename,
		);
		if (!result) return undefined;

		const origFile = new File(
			[new Blob([result.buffer])],
			result.filename,
			{
				type:
					parsed.format ||
					result.format ||
					"application/octet-stream",
			},
		);
		let encryptedFile: File;
		try {
			encryptedFile = await encryptionService.ensureEncrypted(
				origFile,
				fp,
			);
		} catch {
			return undefined;
		}

		const { cid: newCid } = await cas.save(dir, encryptedFile);
		if (!newCid.equals(parsed.cid)) {
			await trashIfUnreferenced(
				cas,
				referenceManager,
				parsed.cid,
				file.path,
			);
		}

		return new IPFSLink({
			cid: newCid,
			filename: encryptedFile.name,
			format: ENCRYPTED_FORMAT,
		}).toURL();
	});
}

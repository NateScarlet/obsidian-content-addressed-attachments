import { Notice, type App, type TFile, type Editor } from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type EncryptionService from "#src/lib/encryption/EncryptionService";
import type EncryptPathPolicy from "#src/lib/encryption/EncryptPathPolicy";
import type { URLResolver } from "#src/URLResolver";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import findIPFSLinks, { type IPFSLinkMatch } from "#src/utils/findIPFSLinks";
import IPFSLink from "#src/utils/IPFSLink";
import VaultLinkTransformer from "#src/utils/VaultLinkTransformer";
import defineLocales from "#src/utils/defineLocales";
import type KeyManager from "#src/lib/encryption/KeyManager";

import type ReferenceManager from "#src/ReferenceManager";

const { t } = defineLocales({
	en: {
		encryptLink: "Encrypt this link",
		decryptLink: "Decrypt this link",
		noKeyAvailable:
			"No encryption key available. Create one in settings first.",
	},
	zh: {
		encryptLink: "加密此链接",
		decryptLink: "解密此链接",
		noKeyAvailable: "没有可用加密密钥。请在设置中先创建密钥。",
	},
});

// #region shared helpers

/** Shared encryption context bundling all common dependencies */
export interface EncryptContext {
	app: App;
	cas: CAS;
	encryptionService: EncryptionService;
	urlResolver: URLResolver;
	referenceManager: ReferenceManager;
	keyManager: KeyManager;
	encryptPathPolicy?: EncryptPathPolicy;
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
		return;
	}

	await cas.trash(cid);
}

/**
 * 加载二进制内容。
 * 优先调用 cas.load(cid) 加载（当文件位于垃圾箱 .trash 中时，cas.load 会自动自动还原并校验文件），
 * 其次回退调用 urlResolver。
 */
async function loadFileContent(
	app: App,
	cas: CAS,
	urlResolver: URLResolver,
	rawURL: string,
): Promise<ArrayBuffer | undefined> {
	const parsed = IPFSLink.parse(rawURL);
	if (parsed) {
		const match = await cas.load(parsed.cid);
		if (match?.normalizedPath) {
			return app.vault.adapter.readBinary(match.normalizedPath);
		}
	}
	const resolved = await urlResolver.resolveURL(rawURL);
	if (resolved?.path) {
		return app.vault.adapter.readBinary(resolved.path);
	}
}

/**
 * Resolve the encryption key fingerprint for a given note path.
 * Priority: explicit fingerprint → path policy → primary key.
 */
async function resolveEncryptFingerprint(
	ctx: EncryptContext,
	notePath: string,
	explicitFingerprint?: string,
): Promise<string | undefined> {
	if (explicitFingerprint) {
		const key = await ctx.keyManager.getKeyForEncrypt(explicitFingerprint);
		if (key) return explicitFingerprint;
	}
	return (await ctx.encryptPathPolicy?.resolveKey(notePath)) ??
		(await ctx.keyManager.getPrimaryKey())?.fingerprint;
}

/**
 * Core encryption logic for a single IPFS link.
 * Returns the new encrypted URL, or undefined if encryption is not needed/possible.
 */
async function encryptSingleLink(
	ctx: EncryptContext,
	linkText: string,
	notePath: string,
	dir: string,
	explicitFingerprint?: string,
): Promise<string | undefined> {
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format === ENCRYPTED_FORMAT) return undefined;

	const buffer = await loadFileContent(ctx.app, ctx.cas, ctx.urlResolver, linkText);
	if (!buffer) return undefined;

	const fingerprint = await resolveEncryptFingerprint(ctx, notePath, explicitFingerprint);
	if (!fingerprint) return undefined;

	const rawFile = new File([new Blob([buffer])], parsed.filename, {
		type: parsed.resolveMimeType(),
	});
	let encryptedFile: File;
	try {
		encryptedFile = await ctx.encryptionService.ensureEncrypted(rawFile, fingerprint);
	} catch {
		return undefined;
	}

	const { cid: newCid } = await ctx.cas.save(dir, encryptedFile);
	if (!newCid.equals(parsed.cid)) {
		await trashIfUnreferenced(ctx.cas, ctx.referenceManager, parsed.cid, notePath);
	}

	return new IPFSLink({
		cid: newCid,
		filename: encryptedFile.name,
		format: ENCRYPTED_FORMAT,
	}).toURL();
}

// #endregion

// #region public commands

export async function encryptLink(
	ctx: EncryptContext,
	editor: Editor,
	match: IPFSLinkMatch,
	notePath: string | undefined,
	dir: string,
): Promise<void> {
	const linkText =
		typeof match.url.toURL === "function" ? match.url.toURL() : undefined;
	if (!linkText) return;

	const newURL = await encryptSingleLink(ctx, linkText, notePath ?? "", dir);
	if (!newURL) {
		new Notice(t("noKeyAvailable"));
		return;
	}

	editor.replaceRange(
		newURL,
		editor.offsetToPos(match.pos[0]),
		editor.offsetToPos(match.pos[1]),
	);
}

export async function decryptLink(
	ctx: EncryptContext,
	editor: Editor,
	match: IPFSLinkMatch,
	notePath: string | undefined,
	dir: string,
): Promise<void> {
	const linkText =
		typeof match.url.toURL === "function" ? match.url.toURL() : undefined;
	if (!linkText) return;
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format !== ENCRYPTED_FORMAT) return;

	const buffer = await loadFileContent(ctx.app, ctx.cas, ctx.urlResolver, linkText);
	if (!buffer) {
		new Notice("File not found");
		return;
	}

	const decrypted = await ctx.encryptionService.ensureDecrypted(buffer);
	if (decrypted.layers.length === 0) {
		new Notice("Not an encrypted file");
		return;
	}

	const file = new File([decrypted.toBlob()], parsed.filename || "file", {
		type: decrypted.mimeType,
	});
	const { cid: newCid } = await ctx.cas.save(dir, file);
	if (!newCid.equals(parsed.cid)) {
		await trashIfUnreferenced(ctx.cas, ctx.referenceManager, parsed.cid, notePath);
	}
	const newURL = new IPFSLink({
		cid: newCid,
		filename: file.name,
		format: file.type,
	}).toURL();

	editor.replaceRange(
		newURL,
		editor.offsetToPos(match.pos[0]),
		editor.offsetToPos(match.pos[1]),
	);
}

export function findLinkAtPos(
	content: string,
	offset: number,
): IPFSLinkMatch | undefined {
	for (const match of findIPFSLinks(content)) {
		if (offset >= match.pos[0] && offset <= match.pos[1]) {
			return match;
		}
	}
}

export function isEncryptedLink(linkText: string): boolean {
	const parsed = IPFSLink.parse(linkText);
	return parsed?.format === ENCRYPTED_FORMAT;
}

export async function encryptNote(
	ctx: EncryptContext,
	file: TFile,
	dir: string,
	explicitFingerprint?: string,
): Promise<number> {
	const fp = await resolveEncryptFingerprint(ctx, file.path, explicitFingerprint);
	if (!fp) return 0;

	const transformer = new VaultLinkTransformer(ctx.app);
	return transformer.transformFile(file, async (_match, linkText) => {
		return encryptSingleLink(ctx, linkText, file.path, dir, fp);
	});
}

// #endregion

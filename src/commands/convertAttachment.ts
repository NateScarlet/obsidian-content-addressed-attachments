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
import trashIfUnreferenced from "./trashIfUnreferenced";
import loadFileContent from "./loadFileContent";

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

/**
 * Resolve the encryption key fingerprint for a given note path.
 * Priority: path policy → primary key.
 */
async function resolveEncryptFingerprint(
	ctx: EncryptContext,
	notePath: string,
): Promise<string | undefined> {
	return (
		(await ctx.encryptPathPolicy?.resolveKey(notePath)) ??
		(await ctx.keyManager.getPrimaryKey())?.fingerprint
	);
}

/**
 * Core encryption logic for a single IPFS link.
 * Returns the new encrypted URL and the old CID (if it should be trashed),
 * or undefined if encryption is not needed/possible.
 */
async function encryptSingleLink(
	ctx: EncryptContext,
	linkText: string,
	notePath: string,
	dir: string,
): Promise<{ newURL: string; oldCID: CID | undefined } | undefined> {
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format === ENCRYPTED_FORMAT) return undefined;

	const buffer = await loadFileContent(
		ctx.app,
		ctx.cas,
		ctx.urlResolver,
		linkText,
	);
	if (!buffer) return undefined;

	const fingerprint = await resolveEncryptFingerprint(ctx, notePath);
	if (!fingerprint) return undefined;

	const rawFile = new File([new Blob([buffer])], parsed.filename, {
		type: parsed.resolveMimeType(),
	});
	let encryptedFile: File;
	try {
		encryptedFile = await ctx.encryptionService.ensureEncrypted(
			rawFile,
			fingerprint,
		);
	} catch {
		return undefined;
	}

	const { cid: newCid } = await ctx.cas.save(dir, encryptedFile);

	return {
		newURL: new IPFSLink({
			cid: newCid,
			filename: encryptedFile.name,
			format: ENCRYPTED_FORMAT,
		}).toURL(),
		oldCID: newCid.equals(parsed.cid) ? undefined : parsed.cid,
	};
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

	const result = await encryptSingleLink(ctx, linkText, notePath ?? "", dir);
	if (!result) {
		new Notice(t("noKeyAvailable"));
		return;
	}

	editor.replaceRange(
		result.newURL,
		editor.offsetToPos(match.pos[0]),
		editor.offsetToPos(match.pos[1]),
	);

	// 替换后再清理旧 CID，避免被当前笔记的引用阻止
	if (result.oldCID) {
		await trashIfUnreferenced(ctx.cas, ctx.referenceManager, result.oldCID);
	}
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

	const buffer = await loadFileContent(
		ctx.app,
		ctx.cas,
		ctx.urlResolver,
		linkText,
	);
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
	const oldCID = newCid.equals(parsed.cid) ? undefined : parsed.cid;
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

	// 替换后再清理旧 CID，避免被当前笔记的引用阻止
	if (oldCID) {
		await trashIfUnreferenced(ctx.cas, ctx.referenceManager, oldCID);
	}
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
): Promise<number> {
	const fp = await resolveEncryptFingerprint(ctx, file.path);
	if (!fp) return 0;

	const cidsToTrash: CID[] = [];
	const transformer = new VaultLinkTransformer(ctx.app);
	const count = await transformer.transformFile(
		file,
		async (_match, linkText) => {
			const result = await encryptSingleLink(
				ctx,
				linkText,
				file.path,
				dir,
			);
			if (result?.oldCID) {
				cidsToTrash.push(result.oldCID);
			}
			return result?.newURL;
		},
	);

	// 文件修改后再清理旧 CID，避免被当前笔记的引用阻止
	for (const cid of cidsToTrash) {
		await trashIfUnreferenced(ctx.cas, ctx.referenceManager, cid);
	}

	return count;
}

// #endregion

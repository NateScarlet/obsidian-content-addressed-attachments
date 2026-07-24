import { Notice, type App, type TFile, type Editor } from "obsidian";
import { CID } from "multiformats/cid";
import type { CAS } from "#src/types/CAS";
import type { EncryptionService } from "#src/lib/encryption/EncryptionService";
import type { EncryptPathPolicy } from "#src/lib/encryption/EncryptPathPolicy";
import type { URLResolver } from "#src/URLResolver";
import { ENCRYPTED_FORMAT } from "#src/lib/encryption/types";
import findIPFSLinks, { type IPFSLinkMatch } from "#src/utils/findIPFSLinks";
import { IPFSLink } from "#src/utils/IPFSLink";
import { VaultLinkTransformer } from "#src/utils/VaultLinkTransformer";
import defineLocales from "#src/utils/defineLocales";
import mimeTypeByExtension from "#src/utils/mimeTypeByExtension";
import type { KeyManager } from "#src/lib/encryption/KeyManager";

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

export async function encryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	urlResolver: URLResolver,
	referenceManager: ReferenceManager,
	dir: string,
	editor: Editor,
	match: IPFSLinkMatch,
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
	const linkText =
		typeof match.url.toURL === "function" ? match.url.toURL() : undefined;
	if (!linkText) return;
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format === ENCRYPTED_FORMAT) return;

	const buffer = await loadFileContent(app, cas, urlResolver, linkText);
	if (!buffer) {
		new Notice("File not found");
		return;
	}

	const rawFile = new File([new Blob([buffer])], parsed.filename, {
		type: parsed.format || mimeTypeByExtension(
			parsed.filename.slice(parsed.filename.lastIndexOf(".")),
		),
	});
	let encryptedFile: File;
	try {
		encryptedFile = await encryptionService.ensureEncrypted(
			rawFile,
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
		editor.offsetToPos(match.pos[0]),
		editor.offsetToPos(match.pos[1]),
	);
}

export async function decryptLink(
	app: App,
	cas: CAS,
	encryptionService: EncryptionService,
	urlResolver: URLResolver,
	referenceManager: ReferenceManager,
	dir: string,
	editor: Editor,
	match: IPFSLinkMatch,
	notePath?: string,
): Promise<void> {
	const linkText =
		typeof match.url.toURL === "function" ? match.url.toURL() : undefined;
	if (!linkText) return;
	const parsed = IPFSLink.parse(linkText);
	if (!parsed || parsed.format !== ENCRYPTED_FORMAT) return;

	const buffer = await loadFileContent(app, cas, urlResolver, linkText);
	if (!buffer) {
		new Notice("File not found");
		return;
	}

	const decrypted = await encryptionService.ensureDecrypted(buffer);
	if (decrypted.layers.length === 0) {
		new Notice("Not an encrypted file");
		return;
	}

	const file = new File([decrypted.toBlob()], parsed.filename || "file", {
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

		const buffer = await loadFileContent(app, cas, urlResolver, linkText);
		if (!buffer) return undefined;

		const origFile = new File([new Blob([buffer])], parsed.filename, {
			type: parsed.format || mimeTypeByExtension(
				parsed.filename.slice(parsed.filename.lastIndexOf(".")),
			),
		});
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

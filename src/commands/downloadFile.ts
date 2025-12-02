import { Notice } from "obsidian";
import type { URLResolver } from "src/URLResolver";
import defineLocales from "src/utils/defineLocales";
import type { IPFSLink } from "src/utils/parseIPFSLink";

export default async function downloadFile(
	resolver: URLResolver,
	link: IPFSLink,
	filename?: string,
): Promise<void> {
	const handle = await window
		.showSaveFilePicker({
			id: "download-d6dc3c38f29f",
			suggestedName:
				filename || link.filename || `${link.cid.toString()}.data`,
			startIn: "downloads",
		})
		.catch(() => undefined);
	if (!handle) {
		return;
	}
	await using stack = new AsyncDisposableStack();
	stack.adopt(new Notice(t("downloading") + "\n" + handle.name, 0), (i) =>
		i.hide(),
	);

	const result = await resolver.resolveURL(link.rawURL);
	if (!result) {
		new Notice(t("notAvailable"));
		return;
	}

	const resp = await window.fetch(result.url);
	const writable = stack.adopt(await handle.createWritable(), (w) =>
		w.close(),
	);
	await writable.write(await resp.blob());
}

const { t } = defineLocales({
	en: {
		notAvailable: "Can not found available external storage for this file",
		downloading: "Downloading",
	},
	zh: {
		notAvailable: "找不到可提供指定文件的外部存储",
		downloading: "正在下载",
	},
});

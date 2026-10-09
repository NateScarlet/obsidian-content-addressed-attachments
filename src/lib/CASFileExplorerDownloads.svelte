<script module lang="ts">
	import formatFileSize from "#src/utils/formatFileSize";
	import defineLocales from "../utils/defineLocales";
	import { getContext } from "./CASFileExplorerContext";
	import { cleanDownloadDirMessages } from "#src/commands/cleanDownloadDir";

	const { t } = defineLocales({
		en: {
			retentionDays: "Retention (days)",
			noDownloadDirs:
				"No download directory configured. Set one in the plugin settings to enable cleanup.",
			clean: "Clean",
			cleaning: "Cleaning expired files",
			...cleanDownloadDirMessages.en,
		},
		zh: {
			retentionDays: "保留期（天）",
			noDownloadDirs: "尚未配置下载目录，请在插件设置中配置后才能清理。",
			clean: "清理",
			cleaning: "清理超期副本",
			...cleanDownloadDirMessages.zh,
		},
	});
</script>

<script lang="ts">
	import { Notice } from "obsidian";
	import cleanDownloadDir from "#src/commands/cleanDownloadDir";
	import { normalizeRetentionDaysInput } from "#src/settings";
	import { casMetadataDelete, casMetadataSave } from "#src/events";
	import showError from "#src/utils/showError";
	import showProgress from "#src/utils/showProgress";

	const {
		cas,
		casMetadata,
		metadataWriteSignal,
		getDownloadDirs,
		getDownloadRetentionDays,
		setDownloadRetentionDays,
	} = getContext();

	let retentionInput = $state(String(getDownloadRetentionDays()));
	/** 清理中的目录：每个目录独立互斥，避免重复点击 */
	let cleaningDirs = $state<string[]>([]);
	/** 各目录占用取自元数据维护的按目录统计，不做全量磁盘扫描 */
	let dirBytes = $state<Record<string, number>>({});

	async function refreshDirBytes() {
		const { dirBytes: bytes } = await casMetadata.estimateStorage();
		dirBytes = bytes;
	}
	$effect(() => {
		void refreshDirBytes();
		// 清理与写入都经后台索引对账后派发事件：副本删净走删除事件，
		// 仍有副本走保存事件，两种事件都要响应才能让占用与实际一致
		const refresh = () => void refreshDirBytes();
		const unsubscribes = [
			casMetadataSave.subscribe(refresh),
			casMetadataDelete.subscribe(refresh),
		];
		return () => {
			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
		};
	});

	const downloadDirs = $derived(getDownloadDirs());

	async function saveRetention() {
		await setDownloadRetentionDays(
			normalizeRetentionDaysInput(retentionInput),
		);
		retentionInput = String(getDownloadRetentionDays());
	}

	async function clean(dir: string) {
		if (cleaningDirs.includes(dir)) return;
		cleaningDirs = [...cleaningDirs, dir];
		const notice = showProgress(t("cleaning"));
		try {
			const { deleted, freedBytes } = await cleanDownloadDir(
				cas,
				{
					dirs: [dir],
					retentionDays: getDownloadRetentionDays(),
					signal: metadataWriteSignal,
				},
				(index, cidStr) => notice.update(index, cidStr),
			);
			new Notice(t("cleaned")(deleted, freedBytes));
		} finally {
			cleaningDirs = cleaningDirs.filter((i) => i !== dir);
			notice.hide();
		}
	}
</script>

<div class="flex flex-col gap-2 p-2">
	<div class="flex items-center gap-2 flex-wrap">
		<label class="text-sm" for="cas-download-retention">
			{t("retentionDays")}
		</label>
		<input
			id="cas-download-retention"
			type="number"
			min="0"
			step="0.1"
			class="w-24 py-1 border border-border rounded text-sm bg-form-field text-normal"
			bind:value={retentionInput}
			onchange={() => saveRetention().catch(showError)}
		/>
	</div>

	{#if downloadDirs.length === 0}
		<p class="text-sm text-muted">{t("noDownloadDirs")}</p>
	{:else}
		<!-- 清理不可逆，提示常驻可见（ADR-0005） -->
		<p class="text-sm text-muted">{t("cleanupWarning")}</p>
		<ul class="flex flex-col gap-1 p-0">
			{#each downloadDirs as dir (dir)}
				<li
					class="flex items-center gap-2 px-2 py-1 border border-border rounded text-sm"
				>
					<span class="flex-1 break-all">{dir}</span>
					<span class="flex-none text-muted">
						{formatFileSize(dirBytes[dir] ?? 0)}
					</span>
					<button
						type="button"
						class="flex-none"
						disabled={cleaningDirs.includes(dir)}
						onclick={() => clean(dir).catch(showError)}
					>
						{t("clean")}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

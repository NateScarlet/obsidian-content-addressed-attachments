<script lang="ts">
	import type { EncryptionKeyInfo } from "./encryption/types";
	import type { EncryptPathRule, Settings } from "#src/settings";
	import type { EncryptionService } from "./encryption/EncryptionService";
	import type { App } from "obsidian";
	import showError from "#src/utils/showError";
	import { Notice } from "obsidian";
	import defineLocales from "#src/utils/defineLocales";

	const { t } = defineLocales({
		en: {
			fingerprint: "Fingerprint",
			createdAt: "Created at",
			rename: "Rename",
			delete: "Delete",
			restore: "Restore",
			setAsPrimary: "Set as primary",
			primary: "Primary",
			createNewKey: "Create new key",
			create: "Create",
			keyNamePlaceholder: "Key name",
			unnamedKey: "Unnamed key",
			defaultKeyName: (ym: string, suffix: string) => `key_${ym}_${suffix}`,
			exportAllKeys: "Export all keys",
			importKeys: "Import keys from backup",
			encryptPathRules: "Auto-encrypt path rules",
			encryptPathRulesDesc:
				"Gitignore-style rules. One pattern per line. Lines starting with # are comments. Attachments in matching notes are automatically encrypted with the selected key.",
			encryptPathRulePatternPlaceholder: "# Example:\nSecret/**\nProjects/*",
			addEncryptPathRule: "Add rule",
			encryptPathRuleNoKeys: "Create a key first",
			encryptMatchingNotes: "Encrypt existing links",
			encryptMatchingNotesHint: "Encrypt all unencrypted attachment links in notes matching this rule",
			noKeys: "No encryption keys yet.",
			keyCreateSuccess: (name: string) => `Key "${name}" created`,
			primarySetSuccess: (name: string) => `"${name}" set as primary key`,
			deletedKeys: "Deleted keys",
			deletedKeysCount: (n: number) => `${n} deleted key(s)`,
			noDeletedKeys: "No deleted keys",
			permanentlyDelete: "Permanently delete",
			permanentlyDeleteDesc: "Permanently delete keys deleted more than X days ago",
			days: "days",
			permanentlyDeleteConfirm: "Permanently delete keys older than the specified days? This cannot be undone.",
			permanentlyDeletedKeysSuccess: (n: number) => `Permanently deleted ${n} key(s)`,
			usePrimaryKey: (name: string) => `Primary key (${name})`,
			none: "None",
		},
		zh: {
			fingerprint: "指纹",
			createdAt: "创建时间",
			rename: "重命名",
			delete: "删除",
			restore: "恢复",
			setAsPrimary: "设为主密钥",
			primary: "主密钥",
			createNewKey: "创建新密钥",
			create: "创建",
			keyNamePlaceholder: "密钥名称",
			unnamedKey: "未命名密钥",
			defaultKeyName: (ym: string, suffix: string) => `密钥_${ym}_${suffix}`,
			exportAllKeys: "导出全部密钥",
			importKeys: "从备份导入密钥",
			encryptPathRules: "自动加密路径规则",
			encryptPathRulesDesc:
				"Gitignore 格式规则，每行一条。以 # 开头的行为注释。匹配的笔记中插入附件时自动用所选密钥加密。",
			encryptPathRulePatternPlaceholder: "# 示例:\nSecret/**\nProjects/*",
			addEncryptPathRule: "添加规则",
			encryptPathRuleNoKeys: "请先创建密钥",
			encryptMatchingNotes: "加密已有链接",
			encryptMatchingNotesHint: "加密此规则匹配笔记中的所有未加密附件链接",
			noKeys: "暂无加密密钥。",
			keyCreateSuccess: (name: string) => `密钥 "${name}" 已创建`,
			primarySetSuccess: (name: string) => `"${name}" 已设为主密钥`,
			deletedKeys: "已删除的密钥",
			deletedKeysCount: (n: number) => `${n} 个已删除的密钥`,
			noDeletedKeys: "没有已删除的密钥",
			permanentlyDelete: "永久删除",
			permanentlyDeleteDesc: "永久删除超过 X 天前删除的密钥",
			days: "天",
			permanentlyDeleteConfirm: "确定要永久删除超过指定天数的密钥吗？此操作不可撤销。",
			permanentlyDeletedKeysSuccess: (n: number) => `已永久删除 ${n} 个密钥`,
			usePrimaryKey: (name: string) => `主密钥 (${name})`,
			none: "无",
		},
	});

	const {
		encryptionService,
		settings,
		saveSettings,
		display,
		app,
		ExportKeysModal,
		ImportKeysModal,
		onEncryptMatchingNotes,
	}: {
		encryptionService: EncryptionService;
		settings: Settings;
		saveSettings: () => Promise<void>;
		display: () => void;
		app: App;
		ExportKeysModal: new (app: App, encryptionService: EncryptionService) => { open(): void };
		ImportKeysModal: new (app: App, encryptionService: EncryptionService) => { open(): void };
		onEncryptMatchingNotes: (keyFingerprint: string, pattern: string) => Promise<void>;
	} = $props();

	let keys = $state<EncryptionKeyInfo[]>([]);
	let deletedKeys = $state<EncryptionKeyInfo[]>([]);
	let newKeyName = $state("");
	let showDeletedKeys = $state(false);
	let permanentDeleteDays = $state(7);

	const primaryKey = $derived(keys[0]);
	const primaryKeyName = $derived(
		primaryKey ? keyDisplayName(primaryKey) : t("none"),
	);

	function formatYearMonth(date: Date | string): string {
		const d = date instanceof Date ? date : new Date(date);
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, "0");
		return `${year}-${month}`;
	}

	function keyDefaultName(key: EncryptionKeyInfo): string {
		const ym = formatYearMonth(key.createdAt);
		const suffix = key.fingerprint.slice(-4);
		return t("defaultKeyName")(ym, suffix);
	}

	function keyDisplayName(key: EncryptionKeyInfo): string {
		return key.name.trim() || keyDefaultName(key);
	}

	async function loadKeys() {
		try {
			keys = await encryptionService.listKeys();
			deletedKeys = await encryptionService.listDeletedKeys();
		} catch (err) {
			showError(err);
		}
	}

	$effect(() => {
		void loadKeys();
	});

	async function createKey() {
		const name = newKeyName.trim();
		try {
			const info = await encryptionService.createKey(name);
			newNotice(t("keyCreateSuccess")(keyDisplayName(info)));
			newKeyName = "";
			await loadKeys();
			display();
		} catch (err) {
			showError(err);
		}
	}

	function newNotice(msg: string) {
		new Notice(msg);
	}

	async function setAsPrimary(key: EncryptionKeyInfo) {
		try {
			await encryptionService.setPrimaryKey(key.fingerprint);
			new Notice(t("primarySetSuccess")(keyDisplayName(key)));
			await loadKeys();
		} catch (err) {
			showError(err);
		}
	}

	async function updateKeyName(key: EncryptionKeyInfo, newName: string) {
		const trimmed = newName.trim();
		try {
			await encryptionService.renameKey(key.fingerprint, trimmed);
			await loadKeys();
		} catch (err) {
			showError(err);
		}
	}

	async function deleteKey(key: EncryptionKeyInfo) {
		try {
			await encryptionService.deleteKey(key.fingerprint);
			await loadKeys();
			display();
		} catch (err) {
			showError(err);
		}
	}

	async function restoreKey(key: EncryptionKeyInfo) {
		try {
			await encryptionService.restoreKey(key.fingerprint);
			await loadKeys();
			display();
		} catch (err) {
			showError(err);
		}
	}

	async function permanentlyDeleteKeys() {
		if (!confirm(t("permanentlyDeleteConfirm"))) return;
		try {
			const count = await encryptionService.permanentlyDeleteKeys(
				permanentDeleteDays,
			);
			new Notice(t("permanentlyDeletedKeysSuccess")(count));
			await loadKeys();
			display();
		} catch (err) {
			showError(err);
		}
	}

	function openExportModal() {
		new ExportKeysModal(app, encryptionService).open();
	}

	function openImportModal() {
		new ImportKeysModal(app, encryptionService).open();
	}

	async function addRule() {
		settings.encryptPathRules.push({
			pattern: "",
			keyFingerprint: "",
		});
		await saveSettings();
		display();
	}

	async function updateRulePattern(rule: EncryptPathRule, value: string) {
		rule.pattern = value;
		await saveSettings();
	}

	async function updateRuleKey(rule: EncryptPathRule, value: string) {
		rule.keyFingerprint = value;
		await saveSettings();
	}

	async function removeRule(rule: EncryptPathRule) {
		settings.encryptPathRules = settings.encryptPathRules.filter(
			(r) => r !== rule,
		);
		await saveSettings();
		display();
	}
</script>

{#if keys.length === 0}
	<div class="text-base-500 py-2">{t("noKeys")}</div>
{/if}

{#each keys as key (key.fingerprint)}
	<div class="flex items-center justify-between gap-2 py-2 border-b border-base-300">
		<div class="flex flex-col min-w-0 flex-1">
			<div class="flex items-center gap-2 min-w-0">
				<input
					type="text"
					class="font-medium bg-transparent border-b border-transparent focus:border-accent focus:bg-base-100 px-1.5 py-0.5 min-w-32 max-w-full text-sm rounded-sm transition-colors"
					placeholder={keyDefaultName(key)}
					value={key.name}
					onchange={(e) => void updateKeyName(key, (e.target as HTMLInputElement).value)}
				/>
				{#if key === keys[0]}
					<span class="text-xs px-1.5 py-0.5 rounded bg-accent/20 text-accent font-medium shrink-0">{t("primary")}</span>
				{/if}
			</div>
			<div class="flex flex-wrap gap-x-3 text-xs text-base-400">
				<span class="truncate">{t("fingerprint")}: {key.fingerprint}</span>
				<span class="truncate">{t("createdAt")}: {key.createdAt instanceof Date ? key.createdAt.toLocaleString() : new Date(key.createdAt).toLocaleString()}</span>
			</div>
		</div>
		<div class="flex gap-1 shrink-0">
			{#if key !== keys[0]}
				<button
					type="button"
					class="px-2 py-1 text-sm hover:bg-accent/10 rounded"
					onclick={() => setAsPrimary(key)}
				>
					{t("setAsPrimary")}
				</button>
			{/if}
			<button
				type="button"
				class="px-2 py-1 text-sm hover:bg-error/10 text-error rounded"
				onclick={() => deleteKey(key)}
			>
				{t("delete")}
			</button>
		</div>
	</div>
{/each}

<div class="flex items-center gap-2 mt-3">
	<input
		type="text"
		class="px-2 py-1 text-sm border border-base-300 rounded flex-1"
		placeholder={t("keyNamePlaceholder")}
		bind:value={newKeyName}
	/>
	<button
		type="button"
		class="px-3 py-1 border border-base-400 rounded hover:bg-base-200 text-sm shrink-0"
		onclick={createKey}
	>
		{t("createNewKey")}
	</button>
</div>

<div class="flex gap-2 py-2">
	<button
		type="button"
		class="px-3 py-1 border border-base-400 rounded hover:bg-base-200"
		onclick={openExportModal}
	>
		{t("exportAllKeys")}
	</button>
	<button
		type="button"
		class="px-3 py-1 border border-base-400 rounded hover:bg-base-200"
		onclick={openImportModal}
	>
		{t("importKeys")}
	</button>
</div>

<!-- 已删除密钥折叠区域 -->
{#if deletedKeys.length > 0}
	<hr class="my-4 border-base-300" />
	<button
		type="button"
		class="flex items-center gap-1 text-sm text-base-400 hover:text-base-600 w-full text-left"
		onclick={() => (showDeletedKeys = !showDeletedKeys)}
	>
		<span class="text-xs">{showDeletedKeys ? "▼" : "▶"}</span>
		<span>{t("deletedKeys")} ({t("deletedKeysCount")(deletedKeys.length)})</span>
	</button>

	{#if showDeletedKeys}
		<div class="mt-2">
			{#each deletedKeys as key (key.fingerprint)}
				<div class="flex items-center justify-between gap-2 py-2 border-b border-base-200 opacity-60">
					<div class="flex flex-col min-w-0 flex-1">
						<div class="text-sm font-medium">
							{keyDisplayName(key)}
						</div>
						<div class="flex flex-wrap gap-x-3 text-xs text-base-400">
							<span class="truncate">{t("fingerprint")}: {key.fingerprint}</span>
							{#if key.deletedAt}
								<span class="truncate">Deleted: {key.deletedAt.toLocaleString()}</span>
							{/if}
						</div>
					</div>
					<div class="flex gap-1 shrink-0">
						<button
							type="button"
							class="px-2 py-1 text-sm hover:bg-accent/10 rounded"
							onclick={() => restoreKey(key)}
						>
							{t("restore")}
						</button>
					</div>
				</div>
			{/each}

			<div class="flex items-center gap-2 mt-3">
				<span class="text-xs text-base-400">{t("permanentlyDeleteDesc")}</span>
				<input
					type="number"
					class="w-16 text-xs"
					min="0"
					bind:value={permanentDeleteDays}
				/>
				<span class="text-xs text-base-400">{t("days")}</span>
				<button
					type="button"
					class="px-2 py-1 text-xs border border-error/40 text-error rounded hover:bg-error/10"
					onclick={permanentlyDeleteKeys}
				>
					{t("permanentlyDelete")}
				</button>
			</div>
		</div>
	{/if}
{/if}

<hr class="my-4 border-base-300" />

<h3 class="text-sm font-medium mb-2">{t("encryptPathRules")}</h3>
<p class="text-xs text-base-400 mb-3">{t("encryptPathRulesDesc")}</p>

{#each settings.encryptPathRules as rule (rule)}
	<div class="p-3 border border-base-300 rounded-lg bg-base-100/50 mb-3 space-y-2">
		<textarea
			class="w-full min-h-20 resize-y font-mono text-xs p-2 border border-base-300 rounded bg-base-100 focus:border-accent"
			placeholder={t("encryptPathRulePatternPlaceholder")}
			value={rule.pattern}
			oninput={(e) => updateRulePattern(rule, (e.target as HTMLTextAreaElement).value)}
		></textarea>
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-2">
				<span class="text-xs text-base-400">{t("keyNamePlaceholder")}:</span>
				<select
					class="dropdown text-xs px-2 py-1 border border-base-300 rounded bg-base-100 min-w-44 focus:border-accent"
					value={rule.keyFingerprint}
					onchange={(e) => updateRuleKey(rule, (e.target as HTMLSelectElement).value)}
				>
					<option value="">{t("usePrimaryKey")(primaryKeyName)}</option>
					{#each keys as k (k.fingerprint)}
						<option value={k.fingerprint}>{keyDisplayName(k)}</option>
					{/each}
				</select>
			</div>
			<div class="flex items-center gap-2">
				{#if keys.length > 0}
					<button
						type="button"
						class="px-2 py-1 text-xs border border-base-400 rounded hover:bg-accent/10 transition-colors"
						title={t("encryptMatchingNotesHint")}
						onclick={() => onEncryptMatchingNotes(rule.keyFingerprint, rule.pattern)}
					>
						{t("encryptMatchingNotes")}
					</button>
				{/if}
				<button
					type="button"
					class="px-2 py-1 text-xs border border-error/40 text-error rounded hover:bg-error/10 transition-colors"
					onclick={() => removeRule(rule)}
				>
					{t("delete")}
				</button>
			</div>
		</div>
	</div>
{/each}

<button
	type="button"
	class="px-3 py-1 border border-base-400 rounded hover:bg-base-200 mt-2 text-xs"
	onclick={addRule}
>
	{t("addEncryptPathRule")}
</button>
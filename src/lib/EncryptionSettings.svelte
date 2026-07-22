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
			encryptPathRulePatternPlaceholder: "# Example:\nSecret/**\nProjects/*\n*.docx",
			addEncryptPathRule: "Add rule",
			encryptPathRuleNoKeys: "Create a key first",
			encryptMatchingNotes: "Encrypt existing links",
			encryptMatchingNotesHint: "Encrypt all unencrypted attachment links in notes matching this rule",
			noKeys: "No encryption keys yet.",
			keyCreateSuccess: (name: string) => `Key "${name}" created`,
			primarySetSuccess: (name: string) => `"${name}" set as primary key`,
		},
		zh: {
			fingerprint: "指纹",
			createdAt: "创建时间",
			rename: "重命名",
			delete: "删除",
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
			encryptPathRulePatternPlaceholder: "# 示例:\nSecret/**\nProjects/*\n*.docx",
			addEncryptPathRule: "添加规则",
			encryptPathRuleNoKeys: "请先创建密钥",
			encryptMatchingNotes: "加密已有链接",
			encryptMatchingNotesHint: "加密此规则匹配笔记中的所有未加密附件链接",
			noKeys: "暂无加密密钥。",
			keyCreateSuccess: (name: string) => `密钥 "${name}" 已创建`,
			primarySetSuccess: (name: string) => `"${name}" 已设为主密钥`,
		},
	});

	const {
		encryptionService,
		settings,
		saveSettings,
		display,
		app,
		ConfirmDeleteKeyModal,
		ExportKeysModal,
		ImportKeysModal,
		onEncryptMatchingNotes,
	}: {
		encryptionService: EncryptionService;
		settings: Settings;
		saveSettings: () => Promise<void>;
		display: () => void;
		app: App;
		ConfirmDeleteKeyModal: new (
			app: App,
			name: string,
			fingerprint: string,
			onDelete: () => Promise<void>,
		) => { open(): void };
		ExportKeysModal: new (app: App, encryptionService: EncryptionService) => { open(): void };
		ImportKeysModal: new (app: App, encryptionService: EncryptionService) => { open(): void };
		onEncryptMatchingNotes: (keyFingerprint: string, pattern: string) => Promise<void>;
	} = $props();

	let keys = $state<EncryptionKeyInfo[]>([]);
	let newKeyName = $state("");

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
			new Notice(t("keyCreateSuccess")(keyDisplayName(info)));
			newKeyName = "";
			await loadKeys();
		} catch (err) {
			showError(err);
		}
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

	function deleteKey(key: EncryptionKeyInfo) {
		new ConfirmDeleteKeyModal(app, keyDisplayName(key), key.fingerprint, async () => {
			await encryptionService.deleteKey(key.fingerprint);
			await loadKeys();
			display();
		}).open();
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
			<div class="flex items-center gap-1.5 min-w-0">
				<input
					type="text"
					class="font-medium bg-transparent border-b border-transparent focus:border-base-400 focus:bg-base-100 px-1 py-0.5 min-w-32 max-w-full text-sm"
					placeholder={keyDefaultName(key)}
					value={key.name}
					onchange={(e) => void updateKeyName(key, (e.target as HTMLInputElement).value)}
				/>
				{#if key === keys[0]}
					<span class="text-xs bg-accent text-accent-inverse px-1 py-0.5 rounded shrink-0">{t("primary")}</span>
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

<div class="flex gap-2 py-2">
	<input
		type="text"
		class="flex-1"
		placeholder={t("keyNamePlaceholder")}
		bind:value={newKeyName}
		onkeydown={(e) => { if (e.key === "Enter") void createKey(); }}
	/>
	<button
		type="button"
		class="px-3 py-1 bg-accent text-accent-inverse rounded hover:opacity-80"
		onclick={createKey}
	>
		{t("create")}
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

<hr class="my-4 border-base-300" />

<h3 class="text-sm font-medium mb-2">{t("encryptPathRules")}</h3>
<p class="text-xs text-base-400 mb-3">{t("encryptPathRulesDesc")}</p>

{#each settings.encryptPathRules as rule (rule)}
	<div class="flex items-start gap-2 py-1">
		<textarea
			class="flex-1 min-h-20 resize-y font-mono text-xs"
			placeholder={t("encryptPathRulePatternPlaceholder")}
			value={rule.pattern}
			oninput={(e) => updateRulePattern(rule, (e.target as HTMLTextAreaElement).value)}
		></textarea>
		<select
			class="min-w-32"
			value={rule.keyFingerprint}
			onchange={(e) => updateRuleKey(rule, (e.target as HTMLSelectElement).value)}
		>
			<option value="">({t("primary")})</option>
			{#each keys as k (k.fingerprint)}
				<option value={k.fingerprint}>{keyDisplayName(k)}</option>
			{/each}
		</select>
		<button
			type="button"
			class="px-2 py-1 text-sm hover:bg-error/10 text-error rounded shrink-0"
			onclick={() => removeRule(rule)}
		>
			{t("delete")}
		</button>
	</div>
	{#if keys.length > 0}
		<button
			type="button"
			class="px-2 py-1 text-xs border border-base-400 rounded hover:bg-accent/10 mt-1"
			title={t("encryptMatchingNotesHint")}
			onclick={() => onEncryptMatchingNotes(rule.keyFingerprint, rule.pattern)}
		>
			{t("encryptMatchingNotes")}
		</button>
	{/if}
{/each}

<button
	type="button"
	class="px-3 py-1 border border-base-400 rounded hover:bg-base-200 mt-2"
	onclick={addRule}
>
	{t("addEncryptPathRule")}
</button>

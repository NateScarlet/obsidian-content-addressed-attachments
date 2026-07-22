<script module lang="ts">
	//#region 国际化字符串
	const { t } = defineLocales({
		en: {
			fingerprint: "Fingerprint",
			rename: "Rename",
			delete: "Delete",
			createNewKey: "Create new key",
			create: "Create",
			keyNamePlaceholder: "Key name",
			unnamedKey: "Unnamed key",
			exportAllKeys: "Export all keys",
			importKeys: "Import keys from backup",
			encryptPathRules: "Auto-encrypt path rules",
			encryptPathRulesDesc:
				"Gitignore-style rules. One pattern per line. Lines starting with # are comments. Attachments in matching notes are automatically encrypted with the selected key.",
			encryptPathRulePatternPlaceholder: "# Example:\nSecret/**\nProjects/*\n*.docx",
			addEncryptPathRule: "Add rule",
			encryptPathRuleNoKeys: "Create a key first",
			noKeys: "No encryption keys yet.",
			keyCreateSuccess: (name: string) => `Key "${name}" created`,
		},
		zh: {
			fingerprint: "指纹",
			rename: "重命名",
			delete: "删除",
			createNewKey: "创建新密钥",
			create: "创建",
			keyNamePlaceholder: "密钥名称",
			unnamedKey: "未命名密钥",
			exportAllKeys: "导出全部密钥",
			importKeys: "从备份导入密钥",
			encryptPathRules: "自动加密路径规则",
			encryptPathRulesDesc:
				"Gitignore 格式规则，每行一条。以 # 开头的行为注释。匹配的笔记中插入附件时自动用所选密钥加密。",
			encryptPathRulePatternPlaceholder: "# 示例:\nSecret/**\nProjects/*\n*.docx",
			addEncryptPathRule: "添加规则",
			encryptPathRuleNoKeys: "请先创建密钥",
			noKeys: "暂无加密密钥。",
			keyCreateSuccess: (name: string) => `密钥 "${name}" 已创建`,
		},
	});
	//#endregion
</script>

<script lang="ts">
	import type { EncryptionKeyInfo } from "./encryption/types";
	import type { EncryptPathRule, Settings } from "#src/settings";
	import type { EncryptionService } from "./encryption/EncryptionService";
	import showError from "#src/utils/showError";
	import { Notice } from "obsidian";
	import defineLocales from "#src/utils/defineLocales";

	const {
		encryptionService,
		settings,
		saveSettings,
		display,
		app,
		RenameKeyModal,
		ConfirmDeleteKeyModal,
		ExportKeysModal,
		ImportKeysModal,
	}: {
		encryptionService: EncryptionService;
		settings: Settings;
		saveSettings: () => Promise<void>;
		display: () => void;
		app: any;
		RenameKeyModal: new (
			app: any,
			fingerprint: string,
			currentName: string,
			keyManager: any,
		) => { open(): void };
		ConfirmDeleteKeyModal: new (
			app: any,
			name: string,
			fingerprint: string,
			onDelete: () => Promise<void>,
		) => { open(): void };
		ExportKeysModal: new (app: any, keyManager: any) => { open(): void };
		ImportKeysModal: new (app: any, keyManager: any) => { open(): void };
	} = $props();

	let keys = $state<EncryptionKeyInfo[]>([]);
	let newKeyName = $state("");

	async function loadKeys() {
		try {
			keys = await encryptionService.listKeys();
		} catch (err) {
			showError(err);
		}
	}

	$effect(() => {
		loadKeys();
	});

	async function createKey() {
		const name = newKeyName.trim() || t("unnamedKey");
		try {
			await encryptionService.keyManager.createKey(name);
			new Notice(t("keyCreateSuccess")(name));
			newKeyName = "";
			await loadKeys();
		} catch (err) {
			showError(err);
		}
	}

	function renameKey(key: EncryptionKeyInfo) {
		new RenameKeyModal(app, key.fingerprint, key.name, encryptionService.keyManager).open();
	}

	function deleteKey(key: EncryptionKeyInfo) {
		new ConfirmDeleteKeyModal(app, key.name, key.fingerprint, async () => {
			await encryptionService.keyManager.deleteKey(key.fingerprint);
			await loadKeys();
			display();
		}).open();
	}

	function openExportModal() {
		new ExportKeysModal(app, encryptionService.keyManager).open();
	}

	function openImportModal() {
		new ImportKeysModal(app, encryptionService.keyManager).open();
	}

	async function addRule() {
		settings.encryptPathRules.push({
			pattern: "",
			keyFingerprint: keys.length > 0 ? keys[0].fingerprint : "",
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
		<div class="flex flex-col min-w-0">
			<span class="font-medium truncate">{key.name}</span>
			<span class="text-xs text-base-400 truncate">{t("fingerprint")}: {key.fingerprint}</span>
		</div>
		<div class="flex gap-1 shrink-0">
			<button
				type="button"
				class="px-2 py-1 text-sm hover:bg-base-200 rounded"
				onclick={() => renameKey(key)}
			>
				{t("rename")}
			</button>
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
		onkeydown={(e) => { if (e.key === "Enter") createKey(); }}
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

{#each settings.encryptPathRules as rule, i (rule)}
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
			{#each keys as k}
				<option value={k.fingerprint}>{k.name}</option>
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
{/each}

<button
	type="button"
	class="px-3 py-1 border border-base-400 rounded hover:bg-base-200 mt-2"
	onclick={addRule}
>
	{t("addEncryptPathRule")}
</button>

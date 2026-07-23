<script lang="ts">
	import type { EncryptionKeyInfo } from "./encryption/types";
	import type { Settings } from "#src/settings";
	import type { App } from "obsidian";
	import { SecretComponent, Setting, Notice } from "obsidian";
	import showError from "#src/utils/showError";
	import defineLocales from "#src/utils/defineLocales";
	import { DEFAULT_KEYS_STORAGE_ID, type KeyManager } from "./encryption/KeyManager";
	import { onMount } from "svelte";

	const { t } = defineLocales({
		en: {
			fingerprint: "Fingerprint",
			createdAt: "Created at",
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
			permanentlyDeleteDaysLabel: "Days",
			permanentlyDeleteButton: "Permanently delete now",
			permanentlyDeletedNotice: (n: number) => `Permanently deleted ${n} key(s)`,
			confirmPermanentDelete: (n: number, d: number) =>
				`Are you sure you want to permanently delete ${n} key(s) that were deleted more than ${d} day(s) ago? This cannot be undone!`,
			deleteRule: "Delete rule",
			primaryKeyFallback: "Primary key",
			none: "None",
			secretStorageId: "Secret Storage ID",
			secretStorageIdDesc: "Select the secret key used to store all encryption keys in Obsidian Secret Storage",
		},
		zh: {
			fingerprint: "指纹",
			createdAt: "创建时间",
			delete: "删除",
			restore: "恢复",
			setAsPrimary: "设为主密钥",
			primary: "主密钥",
			createNewKey: "创建新密钥",
			create: "创建",
			keyNamePlaceholder: "密钥名称",
			unnamedKey: "未命名密钥",
			defaultKeyName: (ym: string, suffix: string) => `密钥_${ym}_${suffix}`,
			exportAllKeys: "导出所有密钥",
			importKeys: "从备份导入密钥",
			encryptPathRules: "自动加密路径规则",
			encryptPathRulesDesc:
				"支持 gitignore 语法。每行一个规则，# 开头的行为注释。匹配笔记中的附件将自动使用指定密钥加密。",
			encryptPathRulePatternPlaceholder: "# 示例：\nSecret/**\nProjects/*",
			addEncryptPathRule: "添加规则",
			encryptPathRuleNoKeys: "请先创建密钥",
			encryptMatchingNotes: "加密已有链接",
			encryptMatchingNotesHint: "加密匹配此规则的笔记中所有未加密的附件链接",
			noKeys: "暂无加密密钥。",
			keyCreateSuccess: (name: string) => `密钥 "${name}" 已创建`,
			primarySetSuccess: (name: string) => `已将 "${name}" 设为主密钥`,
			deletedKeys: "已删除密钥",
			deletedKeysCount: (n: number) => `${n} 个已删除密钥`,
			noDeletedKeys: "无已删除密钥",
			permanentlyDelete: "永久删除密钥",
			permanentlyDeleteDesc: "永久删除已被删除超过指定天数的密钥",
			permanentlyDeleteDaysLabel: "天数",
			permanentlyDeleteButton: "立即永久删除",
			permanentlyDeletedNotice: (n: number) => `已永久删除 ${n} 个密钥`,
			confirmPermanentDelete: (n: number, d: number) =>
				`确定要永久删除已删除超过 ${d} 天的 ${n} 个密钥吗？此操作不可撤销！`,
			deleteRule: "删除规则",
			primaryKeyFallback: "主密钥",
			none: "无",
			secretStorageId: "密钥存储 ID",
			secretStorageIdDesc: "选择在 Obsidian 密钥存储 (Secret Storage) 中保存所有加密密钥的 Secret Key",
		},
	});

	let {
		keyManager,
		settings,
		saveSettings,
		app,
		ExportKeysModal,
		ImportKeysModal,
		onEncryptMatchingNotes,
	}: {
		keyManager: KeyManager;
		settings: Settings;
		saveSettings: () => Promise<void>;
		app: App;
		ExportKeysModal: new (app: App, keyManager: KeyManager) => { open(): void };
		ImportKeysModal: new (app: App, keyManager: KeyManager) => { open(): void };
		onEncryptMatchingNotes: (keyFingerprint: string, pattern: string) => Promise<void>;
	} = $props();

	let secretContainerEl: HTMLDivElement | undefined = $state();
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
			keys = [...(await keyManager.listKeys())];
			deletedKeys = [...(await keyManager.listDeletedKeys())];
		} catch (err) {
			showError(err);
		}
	}

	onMount(() => {
		if (secretContainerEl && app.secretStorage) {
			secretContainerEl.empty();
			const setting = new Setting(secretContainerEl)
				.setName(t("secretStorageId"))
				.setDesc(t("secretStorageIdDesc"));

			 
			new SecretComponent(app, setting.controlEl)
				.setValue(keyManager.getKeysStorageId())
				.onChange(async (newId) => {
					const idToUse = newId.trim() || DEFAULT_KEYS_STORAGE_ID;
					await keyManager.setKeysStorageId(idToUse);
					await loadKeys();
				});
		}
	});

	$effect(() => {
		void loadKeys();
	});

	async function createKey() {
		const name = newKeyName.trim();
		const info = await keyManager.createKey(name);
		newKeyName = "";
		await loadKeys();
		new Notice(t("keyCreateSuccess")(keyDisplayName(info)));
	}

	async function setPrimaryKey(fingerprint: string) {
		await keyManager.setPrimaryKey(fingerprint);
		await loadKeys();
		const k = keys.find((x) => x.fingerprint === fingerprint);
		if (k) {
			new Notice(t("primarySetSuccess")(keyDisplayName(k)));
		}
	}

	async function deleteKey(fingerprint: string) {
		await keyManager.deleteKey(fingerprint);
		await loadKeys();
	}

	async function restoreKey(fingerprint: string) {
		await keyManager.restoreKey(fingerprint);
		await loadKeys();
	}

	async function handlePermanentlyDelete() {
		const cutoffTime = Date.now() - permanentDeleteDays * 24 * 60 * 60 * 1000;
		const eligible = deletedKeys.filter(
			(k) => k.deletedAt && new Date(k.deletedAt).getTime() <= cutoffTime,
		);

		if (eligible.length === 0) return;

		if (
			window.confirm(
				t("confirmPermanentDelete")(eligible.length, permanentDeleteDays),
			)
		) {
			const count = await keyManager.permanentlyDeleteKeys(
				permanentDeleteDays,
			);
			await loadKeys();
			new Notice(t("permanentlyDeletedNotice")(count));
		}
	}

	async function updateKeyName(fingerprint: string, newName: string) {
		const nameToSave = newName.trim();
		await keyManager.renameKey(fingerprint, nameToSave);
		await loadKeys();
	}

	function openExportModal() {
		new ExportKeysModal(app, keyManager).open();
	}

	function openImportModal() {
		new ImportKeysModal(app, keyManager).open();
	}

	function addRule() {
		const rules = [...settings.encryptPathRules];
		rules.push({ pattern: "", keyFingerprint: "" });
		settings.encryptPathRules = rules;
		void saveSettings();
	}

	function removeRule(index: number) {
		const rules = [...settings.encryptPathRules];
		rules.splice(index, 1);
		settings.encryptPathRules = rules;
		void saveSettings();
	}

	function updateRulePattern(index: number, pattern: string) {
		const rules = [...settings.encryptPathRules];
		rules[index] = { ...rules[index], pattern };
		settings.encryptPathRules = rules;
		void saveSettings();
	}

	function updateRuleKey(index: number, keyFingerprint: string) {
		const rules = [...settings.encryptPathRules];
		rules[index] = { ...rules[index], keyFingerprint };
		settings.encryptPathRules = rules;
		void saveSettings();
	}
</script>

<div class="space-y-6">
	<!-- Secret Storage Key 选择配置区域 -->
	<div bind:this={secretContainerEl}></div>

	<!-- 密钥创建与管理面板 -->
	<div class="rounded-lg border border-theme-border bg-theme-bg p-4 shadow-sm">
		<div class="mb-4 flex items-center justify-between">
			<h3 class="text-sm font-semibold text-theme-text">
				{t("createNewKey")}
			</h3>
			<div class="flex gap-2">
				<button
					type="button"
					class="rounded bg-theme-bg-secondary px-3 py-1.5 text-xs text-theme-text hover:bg-theme-border"
					onclick={openImportModal}
				>
					{t("importKeys")}
				</button>
				<button
					type="button"
					class="rounded bg-theme-bg-secondary px-3 py-1.5 text-xs text-theme-text hover:bg-theme-border"
					onclick={openExportModal}
				>
					{t("exportAllKeys")}
				</button>
			</div>
		</div>

		<div class="flex gap-2">
			<input
				type="text"
				bind:value={newKeyName}
				placeholder={t("keyNamePlaceholder")}
				class="flex-1 rounded border border-theme-border bg-theme-bg-secondary px-3 py-1.5 text-xs text-theme-text"
				onkeydown={(e) => e.key === "Enter" && createKey()}
			/>
			<button
				type="button"
				class="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
				onclick={createKey}
			>
				{t("create")}
			</button>
		</div>

		<!-- 密钥列表 -->
		<div class="mt-4 space-y-2">
			{#if keys.length === 0}
				<div class="py-4 text-center text-xs text-theme-text-muted">
					{t("noKeys")}
				</div>
			{:else}
				{#each keys as key, i (key.fingerprint)}
					<div
						class="flex items-center justify-between rounded border border-theme-border bg-theme-bg-secondary p-3"
					>
						<div class="flex flex-col gap-0.5 flex-1 mr-4">
							<div class="flex items-center gap-2">
								<input
									type="text"
									value={key.name}
									placeholder={keyDefaultName(key)}
									class="rounded border-b border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-theme-text hover:border-theme-border focus:border-accent focus:bg-theme-bg focus:outline-none transition-colors min-w-32 max-w-full"
									onchange={(e) =>
										updateKeyName(
											key.fingerprint,
											(e.target as HTMLInputElement).value,
										)}
								/>
								{#if i === 0}
									<span
										class="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent shrink-0"
									>
										{t("primary")}
									</span>
								{/if}
							</div>
							<span class="font-mono text-[10px] text-theme-text-muted px-1">
								FP: {key.fingerprint}
							</span>
						</div>

						<div class="flex items-center gap-2 shrink-0">
							{#if i !== 0}
								<button
									type="button"
									class="text-xs text-theme-text-muted hover:text-theme-text"
									onclick={() => setPrimaryKey(key.fingerprint)}
								>
									{t("setAsPrimary")}
								</button>
							{/if}
							<button
								type="button"
								class="text-xs text-red-500 hover:text-red-600"
								onclick={() => deleteKey(key.fingerprint)}
							>
								{t("delete")}
							</button>
						</div>
					</div>
				{/each}
			{/if}
		</div>

		<!-- 已删除密钥折叠区域 -->
		<div class="mt-6 border-t border-theme-border pt-4">
			<button
				type="button"
				class="flex items-center gap-2 text-xs text-theme-text-muted hover:text-theme-text"
				onclick={() => (showDeletedKeys = !showDeletedKeys)}
			>
				<span>{showDeletedKeys ? "▼" : "▶"}</span>
				<span>{t("deletedKeysCount")(deletedKeys.length)}</span>
			</button>

			{#if showDeletedKeys}
				<div class="mt-3 space-y-2">
					{#if deletedKeys.length === 0}
						<div class="text-xs text-theme-text-muted">
							{t("noDeletedKeys")}
						</div>
					{:else}
						{#each deletedKeys as key (key.fingerprint)}
							<div
								class="flex items-center justify-between rounded border border-theme-border/50 bg-theme-bg-secondary/50 p-2 text-xs"
							>
								<div class="flex flex-col">
									<span class="text-theme-text-muted line-through">
										{keyDisplayName(key)}
									</span>
									<span class="font-mono text-[10px] text-theme-text-muted">
										FP: {key.fingerprint}
									</span>
								</div>
								<button
									type="button"
									class="text-accent hover:underline"
									onclick={() => restoreKey(key.fingerprint)}
								>
									{t("restore")}
								</button>
							</div>
						{/each}

						<div
							class="mt-4 flex items-center justify-between rounded border border-red-500/20 bg-red-500/5 p-3"
						>
							<div class="flex items-center gap-2 text-xs">
								<span>{t("permanentlyDeleteDesc")}</span>
								<input
									type="number"
									bind:value={permanentDeleteDays}
									min="0"
									class="w-16 rounded border border-theme-border bg-theme-bg px-2 py-0.5 text-xs text-theme-text"
								/>
								<span>{t("permanentlyDeleteDaysLabel")}</span>
							</div>
							<button
								type="button"
								class="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
								onclick={handlePermanentlyDelete}
							>
								{t("permanentlyDeleteButton")}
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- 自动加密路径规则设置 -->
	<div class="rounded-lg border border-theme-border bg-theme-bg p-4 shadow-sm">
		<div class="mb-2 flex items-center justify-between">
			<h3 class="text-sm font-semibold text-theme-text">
				{t("encryptPathRules")}
			</h3>
			<button
				type="button"
				class="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover"
				onclick={addRule}
			>
				{t("addEncryptPathRule")}
			</button>
		</div>
		<p class="mb-4 text-xs text-theme-text-muted">
			{t("encryptPathRulesDesc")}
		</p>

		<div class="space-y-3">
			{#each settings.encryptPathRules as rule, index (index)}
				<div
					class="flex flex-col gap-2 rounded border border-theme-border bg-theme-bg-secondary p-3"
				>
					<div class="flex items-center gap-2">
						<textarea
							rows={3}
							value={rule.pattern}
							placeholder={t("encryptPathRulePatternPlaceholder")}
							class="flex-1 rounded border border-theme-border bg-theme-bg px-3 py-1.5 text-xs font-mono text-theme-text resize-y"
							oninput={(e) =>
								updateRulePattern(index, (e.target as HTMLTextAreaElement).value)}
						></textarea>
						<select
							value={rule.keyFingerprint}
							class="rounded border border-theme-border bg-theme-bg px-3 py-1.5 text-xs text-theme-text"
							onchange={(e) =>
								updateRuleKey(index, (e.target as HTMLSelectElement).value)}
						>
							<option value="">
								{t("primaryKeyFallback")} ({primaryKeyName})
							</option>
							{#each keys as k (k.fingerprint)}
								<option value={k.fingerprint}>
									{keyDisplayName(k)} ({k.fingerprint.slice(-4)})
								</option>
							{/each}
						</select>
						<button
							type="button"
							class="text-xs text-red-500 hover:text-red-600"
							onclick={() => removeRule(index)}
						>
							{t("deleteRule")}
						</button>
					</div>

					{#if rule.pattern.trim()}
						<div class="flex justify-end">
							<button
								type="button"
								class="text-[11px] text-accent hover:underline"
								title={t("encryptMatchingNotesHint")}
								onclick={() =>
									onEncryptMatchingNotes(rule.keyFingerprint, rule.pattern)}
							>
								{t("encryptMatchingNotes")}
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
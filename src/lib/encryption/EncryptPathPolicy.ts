import type KeyManager from "./KeyManager";
import type EncryptionService from "./EncryptionService";
import type { BinaryInput } from "#src/utils/toArrayBuffer";
import type { EncryptPathRule } from "#src/settings";
import ignore from "ignore";

/**
 * 每个加密路径规则的匹配器，内部延迟初始化并缓存 ignore 实例。
 */
class EncryptPathRuleMatcher {
	private readonly ig: ReturnType<typeof ignore>;

	constructor(private readonly rule: EncryptPathRule) {
		this.ig = ignore().add(this.rule.pattern);
	}

	match(notePath: string): boolean {
		return this.ig.ignores(notePath);
	}
}

/**
 * # EncryptPathPolicy 笔记路径加密策略管理
 *
 * 专注将 Obsidian 笔记路径 `notePath` 映射到加密规则，决策"是否加密"与"选用哪个密钥"。
 *
 * - **`resolveKey(notePath)`**: 根据笔记路径策略规则，解析应使用的 `keyFingerprint`；
 * - **`ensureEncrypted(input, notePath)`**: 策略层确保加密（匹配路径规则则调 `encryptionService.ensureEncrypted` 加密；未匹配规则则返回 `undefined`）。
 */
export default class EncryptPathPolicy {
	private matcherCache = new WeakMap<
		EncryptPathRule,
		EncryptPathRuleMatcher
	>();

	constructor(
		private readonly keyManager: KeyManager,
		private readonly encryptionService: EncryptionService,
		private readonly getRules: () => EncryptPathRule[] = () => [],
	) {}

	/** 根据笔记路径和规则解析应使用的 keyFingerprint */
	async resolveKey(notePath: string): Promise<string | undefined> {
		const rules = this.getRules();
		// 按密钥 priority 排序：空密钥视为负无穷 priority，其余按密钥 priority 降序
		const allKeys = await this.keyManager.listKeys();
		const priorityMap = new Map(
			allKeys.map((k) => [k.fingerprint, k.priority]),
		);
		const sorted = [...rules].sort((a, b) => {
			const pa = a.keyFingerprint
				? (priorityMap.get(a.keyFingerprint) ?? -Infinity)
				: -Infinity;
			const pb = b.keyFingerprint
				? (priorityMap.get(b.keyFingerprint) ?? -Infinity)
				: -Infinity;
			return pb - pa;
		});
		const matchedRule = sorted.find((r) => {
			let m = this.matcherCache.get(r);
			if (!m) {
				m = new EncryptPathRuleMatcher(r);
				this.matcherCache.set(r, m);
			}
			return m.match(notePath);
		});
		if (!matchedRule) return undefined;

		if (matchedRule.keyFingerprint) {
			const key = await this.keyManager.getKeyForEncrypt(
				matchedRule.keyFingerprint,
			);
			if (key) return matchedRule.keyFingerprint;
		}

		return (await this.keyManager.getPrimaryKey())?.fingerprint;
	}

	/**
	 * 策略层确保加密。
	 * 检查 `notePath` 是否匹配路径规则：
	 * - 匹配规则 ➔ 找到指纹后调用 `encryptionService.ensureEncrypted` 进行强加密并返回密文 File；
	 * - 未匹配规则 ➔ 返回 `undefined`（由调用方按原始明文保存）。
	 */
	async ensureEncrypted(
		input: BinaryInput,
		notePath: string,
	): Promise<File | undefined> {
		const fingerprint = await this.resolveKey(notePath);
		if (!fingerprint) return undefined;

		return this.encryptionService.ensureEncrypted(input, fingerprint);
	}
}

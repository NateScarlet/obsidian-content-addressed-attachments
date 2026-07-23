import type { KeyManager } from "./KeyManager";
import type { EncryptionService, BinaryInput } from "./EncryptionService";
import type { EncryptPathRule } from "#src/settings";
import ignore from "ignore";

/**
 * # EncryptPathPolicy 笔记路径加密策略管理
 *
 * 专注将 Obsidian 笔记路径 `notePath` 映射到加密规则，决策“是否加密”与“选用哪个密钥”。
 *
 * - **`resolveKey(notePath)`**: 根据笔记路径策略规则，解析应使用的 `keyFingerprint`；
 * - **`ensureEncrypted(input, notePath)`**: 策略层确保加密（匹配路径规则则调 `encryptionService.ensureEncrypted` 加密；未匹配规则则返回 `undefined`）。
 */
export class EncryptPathPolicy {
	constructor(
		private readonly keyManager: KeyManager,
		private readonly encryptionService: EncryptionService,
		private readonly getRules: () => EncryptPathRule[] = () => [],
	) {}

	/** 根据笔记路径和规则解析应使用的 keyFingerprint */
	async resolveKey(notePath: string): Promise<string | undefined> {
		const rules = this.getRules();
		const rule = rules.find(
			(r) => r.pattern && ignore().add(r.pattern).ignores(notePath),
		);
		if (!rule) return (await this.keyManager.getPrimaryKey())?.fingerprint;

		if (rule.keyFingerprint) {
			const key = await this.keyManager.getKeyForEncrypt(
				rule.keyFingerprint,
			);
			if (key) return rule.keyFingerprint;
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

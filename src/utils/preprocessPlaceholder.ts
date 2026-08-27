import type { Editor, Vault } from "obsidian";
import { TFile } from "obsidian";
import defineLocales from "./defineLocales";

// 占位符可见文案按界面语言输出；匹配侧有 Block ID 兜底，不受语言影响
const { t } = defineLocales({
	en: {
		inProgress: (filename: string) =>
			`Preprocessing attachment: ${filename}...`,
	},
	zh: {
		inProgress: (filename: string) => `正在预处理附件：${filename}...`,
	},
});

/** Vault 占位符替换所需的最小接口 */
export type PlaceholderReplaceVault = Pick<
	Vault,
	"getAbstractFileByPath" | "process"
>;

/** Editor 占位符替换所需的最小接口 */
export type PlaceholderReplaceEditor = Pick<
	Editor,
	"getValue" | "offsetToPos" | "replaceRange"
>;

// #region 递增序列号与生成器
let sequence = 0;

export interface PreprocessPlaceholderInfo {
	/** 完整 Obsidian 注释占位符文本 */
	placeholder: string;
	/** 唯一的 Block ID，格式如 prep-lz8x2k-1 */
	id: string;
}

/**
 * 创建基于 36 进制时间戳加递增序列号的短小的 Obsidian 注释占位符。
 *
 * 格式：`%% ${t("inProgress")(filename)} ^prep-${timestamp}-${seq} %%`
 */
export function createPreprocessPlaceholder(
	filename: string,
): PreprocessPlaceholderInfo {
	const timestamp = Date.now().toString(36);
	const seq = (sequence++).toString(36);
	const id = `prep-${timestamp}-${seq}`;
	const placeholder = `%% ${t("inProgress")(filename)} ^${id} %%`;

	return { placeholder, id };
}
// #endregion

// #region 占位符内容替换核心函数
/**
 * 从文本中提取 Block ID
 */
export function extractBlockIdFromPlaceholder(
	placeholder: string,
): string | null {
	const match = /\^(prep-[0-9a-z]+-[0-9a-z]+)/.exec(placeholder);
	return match ? match[1] : null;
}

/**
 * 找出占位符（精确字符串匹配或 Block ID 行匹配）在内容中的起始偏移。
 * 找不到时返回 -1。
 */
export function findPlaceholderOffset(
	content: string,
	placeholder: string,
): number {
	// 精确字符串匹配
	const exact = content.indexOf(placeholder);
	if (exact >= 0) {
		return exact;
	}

	// 提取 Block ID 进行保底行匹配
	const blockId = extractBlockIdFromPlaceholder(placeholder);
	if (blockId) {
		const regex = new RegExp(`%%[^\n]*\\^${blockId}[^\n]*%%`);
		const match = regex.exec(content);
		if (match?.index !== undefined) {
			return match.index;
		}
	}

	return -1;
}

/**
 * 在 Markdown 内容中将占位符替换为最终的目标文本。
 *
 * 优先匹配全量 placeholder 字符串；若未精确匹配，尝试提取 ID 并按 Block ID 所在行替换。
 */
export function replacePlaceholderInContent(
	content: string,
	placeholder: string,
	replacement: string,
): string {
	// 精确字符串匹配
	if (content.includes(placeholder)) {
		return content.replace(placeholder, replacement);
	}

	// 提取 Block ID 进行保底行替换
	const blockId = extractBlockIdFromPlaceholder(placeholder);
	if (blockId) {
		const regex = new RegExp(`%%[^\n]*\\^${blockId}[^\n]*%%`, "g");
		if (regex.test(content)) {
			return content.replace(regex, replacement);
		}
	}

	return content;
}

/**
 * 在编辑器中局部替换占位符区间。
 *
 * 通过 `replaceRange` 仅改写占位符区间，CodeMirror 事务自动把光标保持在替换文本末尾，
 * 若用户已把光标移到他处则不被强制跳回。
 *
 * 返回是否发生了替换。
 */
export function replacePlaceholderInEditor(
	editor: PlaceholderReplaceEditor,
	placeholder: string,
	replacement: string,
): boolean {
	const content = editor.getValue();
	const offset = findPlaceholderOffset(content, placeholder);
	if (offset < 0) {
		return false;
	}

	editor.replaceRange(
		replacement,
		editor.offsetToPos(offset),
		editor.offsetToPos(offset + placeholder.length),
	);
	return true;
}
// #endregion

// #region 编辑器与 Vault 异步落盘替换
/**
 * 替换编辑器或磁盘 Vault 中的占位符。
 *
 * 1. 优先在传入的 Editor 中局部替换（view 仍打开时保留光标）；
 * 2. 若占位符已不在 Editor 中（view 被关闭、内容已落盘），回退到 Vault 磁盘文件替换；
 * 3. 两处都未找到占位符时返回 false，由调用方显式通知用户。
 *
 * @returns 是否成功替换占位符
 */
export async function replacePlaceholderInEditorOrVault(
	vault: PlaceholderReplaceVault,
	editor: PlaceholderReplaceEditor,
	notePath: string,
	placeholder: string,
	replacement: string,
): Promise<boolean> {
	// 1. 编辑器优先（view 仍打开时保留光标）
	if (replacePlaceholderInEditor(editor, placeholder, replacement)) {
		return true;
	}

	// 2. 编辑器已被关闭/内容已落盘，回退到 Vault 磁盘文件修改
	if (notePath) {
		const file = vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			let changed = false;
			await vault.process(file, (content: string) => {
				const updated = replacePlaceholderInContent(
					content,
					placeholder,
					replacement,
				);
				changed = updated !== content;
				return updated;
			});
			return changed;
		}
	}

	return false;
}
// #endregion

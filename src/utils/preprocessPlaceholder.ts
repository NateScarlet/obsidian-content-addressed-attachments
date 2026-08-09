import type { App, Editor } from "obsidian";
import { MarkdownView, TFile } from "obsidian";

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
 * 格式：`%% 正在预处理附件：${filename}... ^prep-${timestamp}-${seq} %%`
 */
export function createPreprocessPlaceholder(
	filename: string,
): PreprocessPlaceholderInfo {
	const timestamp = Date.now().toString(36);
	const seq = (sequence++).toString(36);
	const id = `prep-${timestamp}-${seq}`;
	const placeholder = `%% 正在预处理附件：${filename}... ^${id} %%`;

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
 * 在编辑器中替换占位符，并通过内容长度变化量恢复光标位置。
 *
 * `setValue` 整体重写文档会把光标重置到开头；这里先记录占位符起始偏移，
 * 替换后把光标定位到替换文本末尾，保持插入位置不漂移。
 *
 * 返回是否发生了替换。
 */
export function replacePlaceholderInEditor(
	editor: Editor,
	placeholder: string,
	replacement: string,
): boolean {
	const currentContent = editor.getValue();
	const updatedContent = replacePlaceholderInContent(
		currentContent,
		placeholder,
		replacement,
	);
	if (updatedContent === currentContent) {
		return false;
	}

	// 占位符起始偏移，加上替换文本长度即得替换后该处末尾的全局偏移
	const placeholderOffset = findPlaceholderOffset(
		currentContent,
		placeholder,
	);
	editor.setValue(updatedContent);
	if (placeholderOffset >= 0) {
		const newOffset = Math.min(
			placeholderOffset + replacement.length,
			updatedContent.length,
		);
		editor.setCursor(editor.offsetToPos(newOffset));
	}

	return true;
}
// #endregion

// #region 编辑器与 Vault 异步落盘替换
/**
 * 在编辑器视图或磁盘文件 Vault 中搜索并替换占位符。
 *
 * 1. 若给定的 notePath 正处于活态 MarkdownView 的 Editor 中，使用 Editor 操作无缝替换；
 * 2. 否则通过 app.vault.process 修改磁盘上对应的 TFile。
 */
export async function replacePlaceholderInEditorOrVault(
	app: App,
	notePath: string,
	placeholder: string,
	replacement: string,
	fallbackEditor?: Editor,
): Promise<void> {
	// 1. 尝试在所有活动 Markdown 视图的 Editor 中查找并替换
	const leaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) {
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			if (!notePath || view.file?.path === notePath) {
				const editor: Editor = view.editor;
				if (
					replacePlaceholderInEditor(editor, placeholder, replacement)
				) {
					return;
				}
			}
		}
	}

	// 2. 尝试在 fallbackEditor 句柄中直接替换
	if (fallbackEditor) {
		if (
			replacePlaceholderInEditor(fallbackEditor, placeholder, replacement)
		) {
			return;
		}
	}

	// 3. 若处于后台或离线状态，通过 Vault 磁盘文件修改
	if (notePath) {
		const file = app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await app.vault.process(file, (content) =>
				replacePlaceholderInContent(content, placeholder, replacement),
			);
		}
	}
}
// #endregion

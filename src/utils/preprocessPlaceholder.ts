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
				const currentContent = editor.getValue();
				const newContent = replacePlaceholderInContent(
					currentContent,
					placeholder,
					replacement,
				);
				if (newContent !== currentContent) {
					editor.setValue(newContent);
					return;
				}
			}
		}
	}

	// 2. 尝试在 fallbackEditor 句柄中直接替换
	if (fallbackEditor) {
		const currentContent = fallbackEditor.getValue();
		const newContent = replacePlaceholderInContent(
			currentContent,
			placeholder,
			replacement,
		);
		if (newContent !== currentContent) {
			fallbackEditor.setValue(newContent);
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

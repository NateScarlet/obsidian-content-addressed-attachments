import { App, Modal } from "obsidian";
import { MigrationResult } from "./MigrationManager";
import defineLocales from "./utils/defineLocales";

//#region 国际化字符串
const { t } = defineLocales({
	en: {
		migrationProgress: "File Migration Progress",
		scanningFiles: "Scanning and migrating files, please wait...",
		migrationComplete: "✅ Migration Complete",
		migrationInfo: "ℹ️ Migration Complete",
		migratedFiles: (migrated: number) =>
			`Successfully migrated: ${migrated} files`,
		skippedFiles: (skipped: number) => `Skipped: ${skipped} files`,
		errorFiles: (errors: number) => `Errors: ${errors}`,
		viewDetails: "View Details",
		close: "Close",
		migrationFailed: "❌ Migration Failed",
	},
	zh: {
		migrationProgress: "文件迁移进度",
		scanningFiles: "正在扫描和迁移文件，请稍候...",
		migrationComplete: "✅ 迁移完成",
		migrationInfo: "ℹ️ 迁移完成",
		migratedFiles: (migrated: number) => `成功迁移: ${migrated} 个文件`,
		skippedFiles: (skipped: number) => `跳过: ${skipped} 个文件`,
		errorFiles: (errors: number) => `错误: ${errors} 个`,
		viewDetails: "查看详细信息",
		close: "关闭",
		migrationFailed: "❌ 迁移失败",
	},
});
//#endregion

export class MigrationProgressModal extends Modal {
	private result: MigrationResult | null = null;
	private onComplete?: (result: MigrationResult) => void;

	constructor(app: App, onComplete?: (result: MigrationResult) => void) {
		super(app);
		this.onComplete = onComplete;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.addClass("migration-progress-modal");

		contentEl.createEl("h2", { text: t("migrationProgress") });
		contentEl.createEl("div", {
			text: t("scanningFiles"),
			cls: "migration-progress-text",
		});
	}

	updateProgress(result: MigrationResult) {
		this.result = result;
		const { contentEl } = this;

		contentEl.empty();

		if (result.migrated > 0) {
			contentEl.createEl("h2", { text: t("migrationComplete") });
		} else {
			contentEl.createEl("h2", { text: t("migrationInfo") });
		}

		const stats = contentEl.createEl("div", { cls: "migration-stats" });
		stats.createEl("p", {
			text: t("migratedFiles")(result.migrated),
		});
		stats.createEl("p", {
			text: t("skippedFiles")(result.skipped),
		});

		if (result.errors > 0) {
			stats.createEl("p", {
				text: t("errorFiles")(result.errors),
				cls: "text-error",
			});
		}

		// 只在有详细信息时显示
		if (
			result.details.length > 0 &&
			result.details.some(
				(d) => !d.includes("跳过笔记") && !d.includes("Skipped note"),
			)
		) {
			const details = contentEl.createEl("details", {
				cls: "migration-details",
			});
			details.createEl("summary", { text: t("viewDetails") });

			const detailsList = details.createEl("ul");
			result.details.forEach((detail) => {
				detailsList.createEl("li", { text: detail });
			});
		}

		const buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});
		const closeButton = buttonContainer.createEl("button", {
			text: t("close"),
		});
		closeButton.addEventListener("click", () => {
			this.close();
		});

		if (this.onComplete) {
			this.onComplete(result);
		}
	}

	showError(error: string) {
		const { contentEl } = this;

		contentEl.empty();

		contentEl.createEl("h2", { text: t("migrationFailed") });
		contentEl.createEl("p", { text: error });

		const buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});
		const closeButton = buttonContainer.createEl("button", {
			text: t("close"),
		});
		closeButton.addEventListener("click", () => {
			this.close();
		});
	}
}

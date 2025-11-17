import { App, Modal } from "obsidian";
import { MigrationResult, MigrationProgress } from "../MigrationManager";
import defineLocales from "../utils/defineLocales";

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
		processingFile: (current: number, total: number, file: string) =>
			`Processing file ${current}/${total}: ${file}`,
		viewDetails: "View Details",
		close: "Close",
		migrationFailed: "❌ Migration Failed",
		migrationCancelled: "⏹️ Migration Cancelled",
		cancel: "Cancel",
		cancelling: "Cancelling...",
		remainingFiles: (remaining: number) => `${remaining} files remaining`,
	},
	zh: {
		migrationProgress: "文件迁移进度",
		scanningFiles: "正在扫描和迁移文件，请稍候...",
		migrationComplete: "✅ 迁移完成",
		migrationInfo: "ℹ️ 迁移完成",
		migratedFiles: (migrated: number) => `成功迁移: ${migrated} 个文件`,
		skippedFiles: (skipped: number) => `跳过: ${skipped} 个文件`,
		errorFiles: (errors: number) => `错误: ${errors} 个`,
		processingFile: (current: number, total: number, file: string) =>
			`正在处理文件 ${current}/${total}: ${file}`,
		viewDetails: "查看详细信息",
		close: "关闭",
		migrationFailed: "❌ 迁移失败",
		migrationCancelled: "⏹️ 迁移已取消",
		cancel: "取消",
		cancelling: "取消中...",
		remainingFiles: (remaining: number) => `剩余 ${remaining} 个文件`,
	},
});
//#endregion

export class MigrationProgressModal extends Modal {
	private onComplete?: (result: MigrationResult) => void;
	private onCancel?: () => void;
	private isCancelled = false;

	private progressTextEl: HTMLElement;
	private progressStatsEl: HTMLElement;
	private cancelButton: HTMLButtonElement;
	private closeButton: HTMLButtonElement;
	private buttonContainer: HTMLElement;

	constructor(app: App, onComplete?: (result: MigrationResult) => void) {
		super(app);
		this.onComplete = onComplete;
	}

	setOnCancel(callback: () => void) {
		this.onCancel = callback;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.addClass("migration-progress-modal");
		contentEl.setCssStyles({
			padding: "20px",
			maxWidth: "600px",
		});

		const titleEl = contentEl.createEl("h2", {
			text: t("migrationProgress"),
		});
		titleEl.setCssStyles({
			marginTop: "0",
			marginBottom: "15px",
		});

		this.progressTextEl = contentEl.createEl("div", {
			text: t("scanningFiles"),
			cls: "migration-progress-text",
		});
		this.progressTextEl.setCssStyles({
			fontWeight: "bold",
			marginBottom: "10px",
		});

		this.progressStatsEl = contentEl.createEl("div", {
			cls: "migration-stats",
		});
		this.progressStatsEl.setCssStyles({
			margin: "10px 0",
		});

		this.buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});
		this.buttonContainer.setCssStyles({
			display: "flex",
			gap: "10px",
			marginTop: "15px",
		});

		this.cancelButton = this.buttonContainer.createEl("button", {
			text: t("cancel"),
		});
		this.cancelButton.setCssStyles({
			flex: "1",
		});
		this.cancelButton.addEventListener("click", () => {
			this.cancelMigration();
		});

		this.closeButton = this.buttonContainer.createEl("button", {
			text: t("close"),
		});
		this.closeButton.setCssStyles({
			flex: "1",
		});
		this.closeButton.addEventListener("click", () => {
			this.close();
		});
		this.closeButton.hide();
	}

	updateProgress(progress: MigrationProgress) {
		if (
			progress.currentFile &&
			progress.totalFiles &&
			progress.currentFileName
		) {
			this.progressTextEl.setText(
				t("processingFile")(
					progress.currentFile,
					progress.totalFiles,
					progress.currentFileName,
				),
			);
		}

		this.progressStatsEl.empty();

		const migratedEl = this.progressStatsEl.createEl("p", {
			text: t("migratedFiles")(progress.migrated),
		});
		migratedEl.setCssStyles({
			margin: "5px 0",
		});

		const skippedEl = this.progressStatsEl.createEl("p", {
			text: t("skippedFiles")(progress.skipped),
		});
		skippedEl.setCssStyles({
			margin: "5px 0",
		});

		if (progress.errors > 0) {
			const errorEl = this.progressStatsEl.createEl("p", {
				text: t("errorFiles")(progress.errors),
			});
			errorEl.setCssStyles({
				margin: "5px 0",
				color: "var(--text-error)",
			});
		}

		if (progress.totalFiles && progress.currentFile) {
			const remaining = progress.totalFiles - progress.currentFile;
			const remainingEl = this.progressStatsEl.createEl("p", {
				text: t("remainingFiles")(remaining),
			});
			remainingEl.setCssStyles({
				margin: "5px 0",
				color: "var(--text-muted)",
			});
		}

		if (progress.status === "completed") {
			this.showCompletion(progress);
		}
	}

	private showCompletion(result: MigrationProgress) {
		this.progressTextEl.setText(
			result.migrated > 0 ? t("migrationComplete") : t("migrationInfo"),
		);

		this.cancelButton.hide();
		this.closeButton.show();

		if (
			result.details.length > 0 &&
			result.details.some(
				(d) => !d.includes("跳过笔记") && !d.includes("Skipped note"),
			)
		) {
			const details = this.contentEl.createEl("details", {
				cls: "migration-details",
			});
			details.setCssStyles({
				marginTop: "10px",
			});

			const summary = details.createEl("summary", {
				text: t("viewDetails"),
			});
			summary.setCssStyles({
				cursor: "pointer",
				marginBottom: "5px",
			});

			const detailsList = details.createEl("ul");
			detailsList.setCssStyles({
				margin: "5px 0",
				paddingLeft: "20px",
			});

			result.details.forEach((detail) => {
				const li = detailsList.createEl("li", { text: detail });
				li.setCssStyles({
					wordBreak: "break-all",
					fontSize: "0.9em",
					marginBottom: "2px",
				});
			});
		}

		if (this.onComplete) {
			this.onComplete({ ...result, success: true });
		}
	}

	private cancelMigration() {
		this.isCancelled = true;
		this.cancelButton.setText(t("cancelling"));
		this.cancelButton.disabled = true;
		this.progressTextEl.setText(t("migrationCancelled"));

		if (this.onCancel) {
			this.onCancel();
		}
	}

	showCancelled() {
		this.progressTextEl.setText(t("migrationCancelled"));

		this.cancelButton.hide();
		this.closeButton.show();

		const cancelledEl = this.progressStatsEl.createEl("p", {
			text: "迁移已被用户取消",
		});
		cancelledEl.setCssStyles({
			color: "var(--text-warning)",
			margin: "5px 0",
		});
	}

	showError(error: string) {
		this.progressTextEl.setText(t("migrationFailed"));
		const errorEl = this.progressStatsEl.createEl("p", { text: error });
		errorEl.setCssStyles({
			color: "var(--text-error)",
			margin: "5px 0",
		});

		this.cancelButton.hide();
		this.closeButton.show();
	}

	isMigrationCancelled(): boolean {
		return this.isCancelled;
	}
}

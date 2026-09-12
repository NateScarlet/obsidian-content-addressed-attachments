// 开发与生产构建的统一入口，替代旧的 esbuild.config.mjs。
// 构建本体由 rolldown-vite 承担（vite.build.config.mts），本脚本负责：
// - 以子进程方式启动 vite 构建与 tailwind（stdio inherit，受限沙箱内可运行）
// - 生产模式一次性构建；开发模式 watch 构建并在产物变化时重载 Obsidian 插件
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { debounce } from "es-toolkit";

const prod = process.argv[2] === "production";

if (!prod) {
	let isReloading = false;
	let hasPendingReload = false;

	const runReload = () => {
		isReloading = true;
		hasPendingReload = false;
		console.log(
			"Detected change in build outputs. Reloading Obsidian plugin...",
		);
		const reloadProcess = spawn(
			"obsidian",
			["plugin:reload", "id=content-addressed-attachments"],
			{
				shell: true,
				stdio: "inherit",
			},
		);

		const onFinished = () => {
			isReloading = false;
			// 如果在重载期间又有新的构建产物生成，在当前重载结束后立即追加一次重载，确保载入最新代码
			if (hasPendingReload) {
				runReload();
			}
		};

		reloadProcess.on("close", onFinished);
		reloadProcess.on("error", (err) => {
			console.error("Failed to reload plugin via CLI:", err);
			onFinished();
		});
	};

	const triggerReload = debounce(() => {
		// 避免多个重载进程并发执行导致 Obsidian 内部插件实例冲突，采用队列排队机制
		if (isReloading) {
			hasPendingReload = true;
		} else {
			runReload();
		}
	}, 500);

	// 监听构建输出目录的产物文件变化来触发重载。
	// 相比于直接监听特定文件，监听根目录能有效应对某些构建工具或编辑器在保存文件时“先删除再重建”的写入机制，避免监听器句柄失效。
	// 这里通过防抖合并 500ms 内 vite 与 tailwind 同时写入所产生的多个变化事件。
	watch(".", (eventType, filename) => {
		if (filename === "main.js" || filename === "styles.css") {
			triggerReload();
		}
	});
}

const runProcess = (name, args) =>
	new Promise((resolve, reject) => {
		const proc = spawn("pnpm", args, {
			stdio: "inherit",
			shell: true,
		});

		proc.on("close", (code) => {
			if (code === 0) {
				console.log(`${name} completed`);
				resolve();
			} else {
				reject(new Error(`${name} failed with code ${code}`));
			}
		});

		proc.on("error", reject);
	});

await Promise.all([
	// vite（rolldown）构建；--configLoader native 使配置由 Node 原生加载
	runProcess("Vite build", [
		"exec",
		"vite",
		"build",
		"--config",
		"vite.build.config.mts",
		"--configLoader",
		"native",
		"--mode",
		prod ? "production" : "development",
		...(prod ? [] : ["--watch"]),
	]),
	// tailwind
	runProcess("TailwindCSS build", [
		"tailwindcss",
		"-i",
		"src/main.tailwind.css",
		"-o",
		"styles.css",
		...(prod ? ["--minify"] : ["--watch"]),
	]),
]);

console.log("done");

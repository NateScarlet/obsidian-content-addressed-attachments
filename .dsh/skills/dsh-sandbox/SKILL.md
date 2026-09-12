---
name: dsh-sandbox
description: 本仓库（Obsidian 内容寻址附件插件）开发命令在 DSH 受限沙箱下的运行指南。遇到 spawn EPERM (errno -4048)、Access is denied、pnpm install 无输出死锁、sqlite unable to open database file、vite 配置加载失败，或需要判断某命令能否在沙箱内直接跑、是否该申请 danger-full-access 时使用。
---

# DSH 沙箱下的测试与构建

DSH 沙箱施加两类约束，其余异常都是它们的组合：

1. **文件写入只放行 session workspace 与部分平台临时区**（全局 pnpm store、E 盘 git 主仓库等一律被拒）。
2. **禁止子进程 stdio 管道**（Windows 命名管道）：`spawn`/`exec` 默认即 pipe；`inherit` / `ignore` 不受限。

本仓库的测试链路与构建链路均已适配沙箱（vite 8 rolldown 迁移），日常开发循环无需提权。先查状态表，再查陷阱速查表。

## 命令沙箱适配状态

| 命令 | 沙箱内 | 说明 |
|---|---|---|
| `pnpm test` | ✅ 直接跑 | vitest（`--configLoader native` + threads pool）+ svelte-check |
| `pnpm run build:svelte-check` | ✅ 直接跑 | svelte-check 纯进程内 |
| `pnpm lint` | ✅ 直接跑 | eslint 纯进程内 |
| `pnpm run build` | ✅ 直接跑 | preprocess:build（vite 进程内 build()）+ svelte-check + vite 主构建，全链路无子进程管道 |
| `pnpm run build:vite` | ✅ 直接跑 | `vite-build.mjs production`，子进程 stdio inherit |
| `pnpm dev` | ✅ 直接跑 | vite watch + tailwind watch + obsidian plugin:reload，子进程均走 stdio inherit |
| `pnpm run preprocess:build` | ✅ 直接跑 | `build()` 进程内调用 + `configLoader: "native"` |
| `pnpm format` / `format:check` | ⚠️ 未验证 | oxfmt 对 `.md`/`.svelte` 会自身 spawn 子进程（参考 obsidian-plugin 仓库经验）；本仓库源码仅 ts，理论可用，失败则按该仓库同款方式排除或提权 |
| `pnpm install` / `pnpm ls` 等访问 store 的命令 | ❌ 提权 | store 在 workspace 外：`pnpm ls` 报 `[ERR_SQLITE_ERROR] unable to open database file`；install 无声死锁（零输出零 TCP）→ 提权后十余秒完成；依赖树变化后的首次 run 会触发自动 install 并因无 TTY 确认 purge 失败 → 先提权完成一次 install 同步 |
| git 写操作（add/commit/stash…） | ❌ 提权 | gitdir 分离在 `$env:LOCAL_GIT_ROOT`（E 盘），只读操作（status/log/show/diff）不受限 |

## 已落地的适配

新会话遇构建/测试相关失败时优先确认下列设施仍在位，避免重复发明或误"修复"：

- **vite 8（rolldown）+ `@sveltejs/vite-plugin-svelte` 7，移除 esbuild/esbuild-svelte** — vite 8 用 rolldown/oxc napi 原生绑定做 transform 与打包，全部进程内运行，不再 spawn esbuild 服务子进程。这是测试与构建双链路免疫的根基；不要把 vite 降回 7 或重新引入 esbuild。
- **`vite.build.config.mts`** — 主插件构建配置：
  - `svelte({ configFile: false, preprocess: sveltePreprocess(), compilerOptions: {...} })`：显式内联 svelte 配置（等价于原 `svelte.config.mjs`），`experimental.compileModule.exclude: [/\.svelte\.ts$/]` 把 runes 模块从官方 compile-module 手里拿走；
  - `compile-svelte-ts-modules` 插件在 load 阶段一次完成 `.svelte.ts` 的类型剥离（`transformWithOxc` target es2022 降级 `using` 声明）+ `compileModule` runes 编译——vite 8 下官方路径拿到的仍是未剥离 TS 的原始内容；
  - `output.exports: "named"` 复刻 esbuild 导出形态（module.exports.default + __esModule）；
  - `treeshake.manualPureFunctions: ["console.log","console.warn","console.debug"]` 复刻 esbuild pure 剥离（保留 console.error）；
  - `outDir: "."` + `emptyOutDir: false`：产物必须落在仓库根目录供 Obsidian 加载，严禁清空目录。
- **`vite-build.mjs`** — dev/build 统一入口：以 `stdio: "inherit"` 子进程启动 vite 与 tailwind（inherit 免疫管道限制），dev 模式沿用 fs.watch 产物变化 → 防抖触发 `obsidian plugin:reload` 队列。
- **`preprocess.vite.config.mts`** — 预处理脚本多入口构建配置：`build.lib.entry` 对象形式（key = entryName）+ `formats: ["es"]` + `fileName` 函数，多入口产物名与源文件一一对应。注意源码中 `new URL("xxx.js", import.meta.url)` 字面量会被 vite 静态化为资产引用（.ts 会解析到源文件），需要运行时解析的引用（worker/wasm）用变量拼接路径。
- **`scripts/build-preprocess-scripts.mjs`** — 进程内 `build({ configFile, configLoader: "native" })`：`configLoader: "native"` 是关键，缺了它 vite 会用 esbuild 打包配置文件并触发 spawn EPERM。
- **`vitest.config.ts`** — `__dirname` 改由 `import.meta.url` 推导（native 配置加载下不存在 `__dirname`）；`test.pool: "threads"` 替代默认 forks（进程内 worker_threads）。
- **package.json scripts** — vitest 相关命令统一带 `--configLoader native`：配置由 Node 原生 ESM 加载，绕开 vite 用 esbuild 打包配置文件的路径。
- **`.gitignore` 忽略 `.pnpm-store/`**（受限 install 时 pnpm 会把 store 回退到工作区内）。

## 陷阱速查

| 症状 | 根因 | 解法 |
|---|---|---|
| vitest/vite 启动报 `spawn EPERM`（`optimizeSafeRealPathSync`/`externalize-deps`） | 配置文件走了 esbuild 打包路径（会 spawn） | 确认 vitest 命令带 `--configLoader native`、进程内 `build()` 传 `configLoader: "native"` |
| `ReferenceError: __dirname is not defined in ES module scope`（native 配置加载下） | native loader 以原生 ESM 运行配置文件 | 配置内用 `fileURLToPath(import.meta.url)` 推导目录，勿用 `__dirname` |
| 构建 `[UNRESOLVED_ENTRY] Cannot resolve entry module index.html` | 未声明入口且 lib.entry/input 缺失 | 多入口用 `build.lib.entry` 对象形式（官方文档 build-options#build-lib），不要自创 esbuild 的 `entryPoints` 键 |
| `new URL("x.js", import.meta.url)` 被改写/告警 `doesn't exist at build time` | vite 把字面量形式静态化为资产引用（.js 会解析到 .ts 源文件） | 需要运行时解析的引用用变量拼接：`const f = "x.js"; new URL(f, import.meta.url)` |
| 产物加载后 Obsidian 报插件类不存在 | 导出形态错误 | 确认 `output.exports: "named"` 仍在位，产物应为 `module.exports.default` |
| 产物体积异常偏大 / 出现调试日志 | manualPureFunctions 剥离失效 | 对照 `vite.build.config.mts` 的 rollupOptions.treeshake |
| pnpm run 中途报 `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]` | 依赖树与 lockfile 不同步触发自动 install | 提权执行一次 `CI=true pnpm install` 完成同步后再回到沙箱 |
| `pnpm ls` 报 `[ERR_SQLITE_ERROR] unable to open database file` | store 元数据库在 workspace 外 | 版本核对改看 `node_modules/.pnpm` 目录名；确需 pnpm 则提权 |
| `pnpm install` 长时间零输出不退出 | 文件过滤层导致的无声死锁 | **立即提权** danger-full-access 重跑同一命令；提权下正常安装仅需十余秒 |
| git add/commit 报 `Unable to create ... index.lock: Permission denied` | gitdir 分离在 E 盘（`$env:LOCAL_GIT_ROOT`） | 提权重跑同一 git 命令；只读 git 命令不需要提权 |

## 历史教训（勿重蹈）

- 旧 esbuild 管线时代，`pnpm dev/build` 因 esbuild JS API 服务进程必需 stdio 管道而只能提权运行——这正是迁移到 rolldown-vite 的动因。若有人提议重新引入基于 esbuild JS API 的工具（esbuild-svelte、vite ≤7 等），会直接破坏沙箱免疫。
- 多入口产物名靠 `build.lib.entry` 对象 key + `fileName(format, entryName)` 函数；依赖运行时解析的相对引用（worker/wasm）在源码里用变量拼接路径，避免被静态化为资产。

## 提权规范

- `sandbox_permissions: danger-full-access` 只能作为刚被沙箱拒绝的操作的一次性重试，附一句话 justification 说明哪一步被哪类约束阻塞。探索性命令不提权。
- 同一操作第二次失败于同类 EPERM 时，正确动作是提权重跑而不是寻找第三种绕行方式。
- 提权对照（假阳性判定）：同一命令完全权限成功、受限模式失败 ⇒ 根因是沙箱而非代码。此时受限环境下的报错内容不可采信——哪怕是看似合理的业务错误文本。禁止依据受限环境下的报错去修改业务配置。
- 当前会话状态：`vitest/svelte-check/eslint/vite build/dev` 提权前先确认上表标 ✅ 的设施仍在位；install 与 git 写操作按表提权。

## 红线

- **清理残留进程前先验明正身**：DSH 宿主本身就是 node 进程，误杀等于中断自己的工具调用。受限模式下 `Get-CimInstance` 查询进程命令行也会被拒而无法验明正身——默认交给 `job_kill` 由运行时收尾，不手动杀进程树。
- **同一时刻只跑一个安装任务**。

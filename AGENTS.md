# Obsidian 内容寻址附件插件开发指南

## 开发环境与工具链

- **Node.js**：建议使用当前 LTS 版本（推荐 Node 18+）。
- **包管理器**：`npm`（项目定义了相应的 npm 脚本和依赖）。
- **构建工具**：`esbuild`（由 `esbuild.config.mjs` 配置打包逻辑）。
- **类型诊断**：针对 Svelte 组件使用 `svelte-check` 进行类型诊断。
- **样式**：配合 TailwindCSS 进行 CSS 样式编译。

### 安装依赖

```powershell
pnpm install
```

### 监视并自动构建（开发模式）

```powershell
pnpm run dev
```

该命令只开发主插件，不支持预处理脚本热加载。修改 `preprocess-scripts/` 后需要手动运行：

```powershell
pnpm run preprocess:build
```

### 生产环境打包构建

```powershell
pnpm run build
```

该命令会依次执行 `npm run build:svelte-check` 诊断 Svelte 类型问题，以及 `npm run build:esbuild` 编译打包 js/css 资源。

### 预处理可复用转码 E2E 测试

`tests/e2e/preprocess-pipeline.spec.mts` 在**真实 Obsidian 桌面端**中用 Playwright 连 CDP 来驱动「插入附件 → 预处理 → CAS 落盘 → 链接」的完整链路，断言转换后的格式、落盘 CID 一致性与 magic bytes。

测试脚本**不负责启动/装配环境**，只连接一个已就绪的 Obsidian 实例（默认 `127.0.0.1:9222`，`OBSIDIAN_CDP_PORT` 可覆盖）。实例由桌面端 skill 或 CI workflow 各自提供：

- **桌面端**：先用 `debug-obsidian-plugin` skill 的 `start.ps1` 启动隔离实例（已信任并启用插件），再执行 `pnpm run e2e:vault` 把预处理脚本产物 `dist/preprocess-scripts` 装配进 skill 生成的 vault，最后 `pnpm run e2e`。
- **CI（GitHub Actions）**：尚未实现，由 workflow 自行配置（下载 AppImage 解包、Xvfb、安装插件与预处理产物、开启 CDP），再跑同一个 `pnpm run e2e`。该自动化方案在 [issue #29](https://github.com/NateScarlet/obsidian-content-addressed-attachments/issues/29) 中跟踪，避免在测试脚本里耦合环境装配。

预览附件 fixture 位于 `tests/e2e-vault/fixtures/`（含 HEIC/PNG）。新增转换格式时，在 `tests/e2e/preprocess-pipeline.spec.mts` 增加用例即可。

## 项目上下文

See [`CONTEXT.md`](./CONTEXT.md) for project overview and directory structure.

## 编码规范

See [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) for coding conventions, engineering principles, and i18n guidelines.

## Agent skills

### Issue tracker

Issues are tracked on GitHub. See [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

### Triage labels

Five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

Single-context layout. See [`docs/agents/domain.md`](./docs/agents/domain.md).

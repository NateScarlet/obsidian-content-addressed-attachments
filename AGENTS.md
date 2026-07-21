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

### 生产环境打包构建

```powershell
pnpm run build
```

该命令会依次执行 `npm run build:svelte-check` 诊断 Svelte 类型问题，以及 `npm run build:esbuild` 编译打包 js/css 资源。

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

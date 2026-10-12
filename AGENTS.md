# Obsidian 内容寻址附件插件开发指南

## 开发环境与工具链

- **Node.js**：建议使用当前 LTS 版本（推荐 Node 18+）。
- **包管理器**：`pnpm`（项目定义了相应的 npm 脚本和依赖）。
- **构建工具**：`vite`（rolldown-vite 8，由 `vite.build.config.mts` 配置主插件打包逻辑，`vite-build.mjs` 为 dev/build 统一入口；预处理脚本由 `preprocess.vite.config.mts` 多入口构建）。
- **类型诊断**：针对 Svelte 组件使用 `svelte-check` 进行类型诊断。
- **样式**：配合 TailwindCSS 进行 CSS 样式编译。
- **DSH 受限沙箱**：测试与构建链路已适配沙箱免提权运行；`pnpm install` 与 git 写操作需提权。见 [.dsh/skills/dsh-sandbox/SKILL.md](./.dsh/skills/dsh-sandbox/SKILL.md)。

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

该命令会依次执行 `pnpm run preprocess:build` 构建预处理脚本、`pnpm run build:svelte-check` 诊断 Svelte 类型问题，以及 `pnpm run build:vite` 编译打包 js/css 资源。

### 预处理可复用转码 E2E 测试

`tests/e2e/preprocess-pipeline.spec.mts` 在**真实 Obsidian 桌面端**中用 Playwright 连 CDP 来驱动「插入附件 → 预处理 → CAS 落盘 → 链接」的完整链路，断言转换后的格式、落盘 CID 一致性与 magic bytes。

测试脚本**不负责启动/装配环境**，只连接一个已就绪的 Obsidian 实例（默认 `127.0.0.1:9222`，`OBSIDIAN_CDP_PORT` 可覆盖）。实例由桌面端 skill 或 CI workflow 各自提供：

- **桌面端**：先用 `debug-obsidian-plugin` skill 的 `start.ps1` 启动隔离实例（已信任并启用插件），再执行 `pnpm run e2e:vault` 把预处理脚本产物 `dist/preprocess-scripts` 装配进 skill 生成的 vault，最后 `pnpm run e2e`。
- **CI（GitHub Actions）**：`.github/workflows/e2e.yml` 在 PR、master push 与手动触发时自配环境后跑同一个 `pnpm run e2e`：下载固定版本与校验和的 Obsidian AppImage 并解包、安装 Xvfb，用 `scripts/e2e-provision.mjs` 装配一次性 vault 与插件（含 `dist/preprocess-scripts`），Xvfb 下启动并开启 CDP 9222，再用 `scripts/e2e-enable-plugin.mjs` 完成插件信任与启用，最后运行测试。环境装配只存在于 workflow、这两个脚本与桌面端 skill 流程中，测试脚本保持零环境耦合。

预览附件 fixture 位于 `tests/e2e-vault/fixtures/`（含 HEIC/PNG）。新增转换格式时，在 `tests/e2e/preprocess-pipeline.spec.mts` 增加用例即可。

## 项目概述

Obsidian 社区插件（TypeScript 编译打包为单文件 JavaScript）：基于内容寻址存储（CAS）管理
Obsidian 的本地与网络附件，按文件内容的 CID 分片存储与去重，防止附件丢失和重复；支持附件
加密（AES-256-GCM），加密文件在存储前自动加密、读取时透明解密。

- **入口文件**：`src/main.ts`。经编译生成根目录的发布产物 `main.js`，由 Obsidian 加载。
- **发布产物**：`main.js`、`manifest.json` 和可选的 `styles.css`。

领域词汇见 [`CONTEXT.md`](./CONTEXT.md)（**仅词汇表**）；架构决策见 [`docs/adr/`](./docs/adr/)；
文档分层规则见 [`CODING_STANDARDS.md`](./CODING_STANDARDS.md#文档分层)。

## 目录结构

```text
src/
  main.ts                   # 插件入口，仅用于生命周期、命令注册与配置加载
  settings.ts               # 设置项的数据结构、校验及默认配置
  commands/                 # 独立的交互和批处理业务命令函数（不挂载于主类）
    insertAttachment.ts
    restoreReferencedFiles.ts
    emptyTrash.ts
    ...
  infrastructure/           # 数据与文件底层存储实现
    local/
      CASImpl.ts            # 本地内容寻址存储（CAS）物理文件操作（含回收站）
    indexed-db/
      CASMetadataImpl.ts    # 附件 CID 元数据 IndexedDB 实现
      ReferenceManagerCache.ts # 引用关系缓存数据库实现
  lib/                      # 核心 Svelte UI 交互组件
    CASFileExplorer.svelte
    CASFileExplorerHeader.svelte
    EncryptionSettings.svelte  # 加密密钥管理设置面板
    encryption/               # 加密子系统
      EncryptionService.ts    # 加解密应用层门面
      KeyManager.ts           # 密钥生命周期管理（基于 Obsidian SecretStorage）
      CryptoService.ts        # AES-256-GCM 物理加解密
      EncryptPathPolicy.ts    # 笔记路径加密策略
      cryptoUtils.ts          # Web Crypto API 封装
      fileHeader.ts           # 加密文件头解析
      constants.ts            # 加密常量
      types.ts                # 加密类型定义
    ...
  ui/                       # Obsidian 面板、视图和弹窗包装器
    CASFileExplorerView.ts  # Obsidian Panel 视图绑定
    MainPluginSettingTab.ts # 设置页面
  types/                    # 各种核心组件的契约和接口定义
  utils/                    # 工具辅助函数与多语言国际化宏

preprocess-scripts/         # 官方维护的预处理脚本源码（构建入口在 scripts/build-preprocess-scripts.mjs 中写死）
  registry.json             # 脚本注册表：包含官方与社区预设条目（vault-relative/https/ipfs/internal.ipfs-locked）
  shared-types.ts           # 脚本端与插件端共享的类型定义
```

预处理脚本的用法、URL 规范与贡献流程见 [`docs/preprocess-scripts.zh-CN.md`](./docs/preprocess-scripts.zh-CN.md)
（英文版 `docs/preprocess-scripts.en.md`）。

## 编码规范

See [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) for coding conventions, engineering principles, and i18n guidelines.

## Agent skills

### Issue tracker

Issues are tracked on GitHub. See [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

### Triage labels

Five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

Single-context layout. See [`docs/agents/domain.md`](./docs/agents/domain.md).

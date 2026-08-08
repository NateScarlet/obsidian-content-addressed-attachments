# CONTEXT.md

## 项目概述

- **目标**：Obsidian 社区插件（将 TypeScript 编译并打包为单文件 JavaScript）。
- **插件定位**：基于内容寻址存储（CAS）管理 Obsidian 的本地和网络附件（基于文件内容的 CID 进行分片存储与去重，防止附件丢失和重复）。支持附件加密（AES-256-GCM），加密文件在存储前自动加密，读取时透明解密。
- **入口文件**：`src/main.ts`。经编译生成根目录下的发布产物 `main.js` 由 Obsidian 加载。
- **发布产物**：`main.js`、`manifest.json` 和可选的 `styles.css`。

## 项目目录结构

```
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

## 预处理脚本命名约定

预处理功能采用三词分工，杜绝 "preset" 一词：

- **脚本（preprocess script）**：可执行的转换模块，官方维护者写在 `preprocess-scripts/` 下（构建入口在构建配置中写死）；高级用户可自写脚本并配置 URL。
- **注册表（registry）**：`preprocess-scripts/registry.json`，统一维护预设脚本列表。官方脚本用 vault 相对路径，社区贡献脚本以 `internal.ipfs-locked:` 或 HTTPS URL 提交。
- **生成索引（generated index）**：`src/preprocess/script-index.generated.json`，由 `scripts/build-preprocess-scripts.mjs` / `scripts/update-preprocess-index.mjs` 生成，提交进 repo、由插件运行时 import 供设置下拉使用。`.generated` 后缀明确表示这是构建产物而非手改源文件。

`scriptURL` 支持多种 scheme：vault 相对路径、`https:`、`ipfs:`、`internal.ipfs-locked:`；参数经 URL fragment 传入。首个正式脚本发布前 index 条目使用 vault 相对路径，发布后切换为 `internal.ipfs-locked:<cid>,<release-url>`。

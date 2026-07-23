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
    ...
  ui/                       # Obsidian 面板、视图和弹窗包装器
    CASFileExplorerView.ts  # Obsidian Panel 视图绑定
    MainPluginSettingTab.ts # 设置页面
  types/                    # 各种核心组件的契约和接口定义
  utils/                    # 工具辅助函数与多语言国际化宏
```

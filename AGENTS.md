# Obsidian 内容寻址附件插件开发指南

## 项目概述

- **目标**：Obsidian 社区插件（将 TypeScript 编译并打包为单文件 JavaScript）。
- **插件定位**：基于内容寻址存储（CAS）管理 Obsidian 的本地和网络附件（基于文件内容的 CID 进行分片存储与去重，防止附件丢失和重复）。
- **入口文件**：`src/main.ts`。经编译生成根目录下的发布产物 `main.js` 由 Obsidian 加载。
- **发布产物**：`main.js`、`manifest.json` 和可选的 `styles.css`。

## 开发环境与工具链

- **Node.js**：建议使用当前 LTS 版本（推荐 Node 18+）。
- **包管理器**：`npm`（项目定义了相应的 npm 脚本和依赖）。
- **构建工具**：`esbuild`（由 `esbuild.config.mjs` 配置打包逻辑）。
- **类型诊断**：针对 Svelte 组件使用 `svelte-check` 进行类型诊断。
- **样式**：配合 TailwindCSS 进行 CSS 样式编译。

### 安装依赖

```powershell
npm install
```

### 监视并自动构建（开发模式）

```powershell
npm run dev
```

### 生产环境打包构建

```powershell
npm run build
```

该命令会依次执行 `npm run build:svelte-check` 诊断 Svelte 类型问题，以及 `npm run build:esbuild` 编译打包 js/css 资源。

## 代码与目录约定

- **业务逻辑与生命周期剥离**：`src/main.ts` 应保持小巧，仅负责插件生命周期注册（`onload`/`onunload`）、少量的基本实例化和命令、设置的注册。严禁将具体的复杂业务逻辑（如具体的解析、恢复、修改逻辑）无限堆积在主类中。
- **项目目录结构布局**：
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
- **禁止提交构建产物**：不要将 `node_modules/`、`main.js` 以及其他打包生成的文件提交到代码版本控制中。

## 核心开发原则与工程规范

### 1. 最小接口原则
- 插件主类（`ContentAddressedAttachmentPlugin`）和各个管理器（如 `ReferenceManager`）不应无限扩充其实例方法。
- 当有新的交互、恢复或批处理功能时，应将其作为独立的业务函数写在 `src/commands/` 目录中。
- 命令函数应当接收显式且最小化的依赖参数（例如直接接收 `cas: CAS`, `casMetadata: CASMetadata` 等），严禁随意传递巨大的臃肿上下文。

### 2. 组件依赖隔离
- Svelte UI 等视图组件应当通过 getContext 接收其所需的直接依赖参数，而不要通过间接依赖访问其他层级的对象（例如，严禁让 `ReferenceManager` 暴露 `plugin` 来给组件调用，组件必须直接获取直接依赖）。

### 3. 防抖聚合通知
- 诸如“自动恢复附件”等操作，有可能会因为后台大批量索引扫描（`doIncrementalScan`）而在短时间内发生高强度的并发调用。
- 为了防止 Notice 通知刷屏影响用户体验，在命令层或通知层必须设计防抖合并计时器（如 `500ms` 内），把所有的变化数量进行累加，最后仅弹出单条合并后的 Notice 提示信息。

### 4. 纯本地物理操作原则
- 针对回收站文件物理恢复等动作，应通过 `cas.restoreIfTrashed(cid)` 等接口在本地进行文件重命名物理移动，严禁随意调用如 `cas.load` 等会导致在本地找不到物理文件时回退去执行网络网关（Gateway）下载的方法，避免引入非预期的网络流量和延迟。

### 5. 资源与事件清理
- Obsidian 插件需要保证热重载的干净卸载。所有注册的 DOM 监听器、事件监听器、定时器必须在 `onunload` 或通过 `this.registerEvent` / `this.registerDomEvent` 辅助工具进行注册，确保插件卸载时资源能够被 100% 自动安全回收。

## 国际化多语言支持

- 使用 `defineLocales` 定义中英文提示：
  ```ts
  const { t } = defineLocales({
      en: {
          loading: "Loading",
      },
      zh: {
          loading: "正在加载",
      }
  });
  ```
- 提示文本如果需要支持动态变量，可在 Locale 中定义函数参数并在调用时执行，如 `t("myMsg")(count)`。

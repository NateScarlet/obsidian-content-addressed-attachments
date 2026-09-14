# CONTEXT.md

## Language

**来源（source）**：
一次解析中可尝试获取内容的任一远程 HTTP 端点的统称，包括网关与源站。
_Avoid_: 候选、remote source

**源站**：
锁定链接（`internal.ipfs-locked:`）中记录的原始服务 URL，是来源的一种，与网关相区分。

**网关（gateway）**：
用户在设置中配置的 URL 模板化远程服务，是来源的一种。

**探测（probe）**：
以测量某来源所在 Host 的可达性与往返延迟为目的的轻量请求；不判定内容是否存在。
_Avoid_: 预检（与 CORS preflight 混淆）

**合并批（coalescing batch）**：
把同一注册窗口（同步块）内并发到达的请求自动合并为单个事务的通用机制
（go 参照 `runInBatch`+`loop` 收集循环，`src/utils/CoalescingBatch.ts`）：
写入侧把并发 `merge` 合并为一个 IndexedDB 读写事务，查询侧把并发引用计数
查询合并为一个只读事务；调用方无需感知「逐条 vs 批量」、无需自行分块。
其收益依赖调用方的并行消费堆积，且并行消费由 `orderedParallelMap` 的有界并发
承担（同批投影在同一同步块内启动），故并发上限同时是合并批宽。
_Avoid_: 批量写入、mergeBatch

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
- **生成索引（generated index）**：`src/preprocess/script-index.generated.json`，由 `scripts/generate-preprocess-index.mjs` 在发布流程中生成（把条目改写为 release CID 的 `internal.ipfs-locked:` 格式），用于构建发布版插件；生成结果不提交回仓库，仓库中维护的是开发用版本（vault 相对路径）。由插件运行时 import 供设置下拉使用。`.generated` 后缀明确表示这是构建产物而非手改源文件。

`scriptURL` 支持多种 scheme：vault 相对路径、`https:`、`ipfs:`、`internal.ipfs-locked:`；参数经 URL fragment 传入。首个正式脚本发布前 index 条目使用 vault 相对路径，发布后切换为 `internal.ipfs-locked:<cid>,<release-url>`。

## 数据权威：磁盘为唯一可信源

附件的事实（是否存在、在哪个目录、路径/URL）以**磁盘文件系统**为唯一权威，IndexedDB 元数据（`CASMetadataImpl`/`ReferenceManagerCache`）**不是**权威源，只是可推导、可删除重建的索引：

- 事实判定必须基于磁盘探测（`adapter.stat`/`exists` + CID 推导路径），不得依赖或等待 IndexedDB。
- 元数据删除后按磁盘实际内容重建即可恢复正确；元数据丢失与磁盘真实缺失是不同的严重级别——前者可重建，后者才是真缺失。
- 因此元数据同步（`meta.get/merge/delete`）是索引维护，不应阻塞任何仅需磁盘结果的操作（典型如 `resolveURL` 解析出落盘路径即可返回，不应被 IndexedDB 忙碌时的元数据写入拖住）。重建索引对账即遵循此原则（见下）。
- 元数据写入经存储层合并批缓冲（见 Language「合并批」）：`merge` 单条调用在同一注册窗口内自动合并为一个读写事务，达到批上限（1000）才切新批，无积压时单条零等待（maxWait 而非 minWait）；调用方并行调用单条 `merge` 即可获得批量收益（重建索引与写侧同步服务均经 `orderedParallelMap` 的有界并发并行调用），无需也不应使用批量入口。

## 回收站与多目录副本状态

附件元数据（`CASMetadataObject`）用 `copies: [{dir, trashedAt?}]` 记录附件副本**实例**，不使用单一 `trashedAt` 字段：

- 每个物理副本一条实例，允许同一目录同时存在正常与回收两个实例（per-instance 模型，`src/utils/casCopies.ts` 的 `mergeCopies` 按"目录+是否回收"合并）。
- 回收站判定：任一副本实例 `trashedAt` 非空（`isCASObjectTrashed`）。
- 写入元数据时**不**扫描磁盘来判定回收站状态：`index`/`save` 保留已有副本状态；`trash`/`load`/`restoreIfTrashed`/`deleteIfTrashed` 基于磁盘操作重建副本状态。
- 回收站副本的回收时间**以元数据既有值为准**：磁盘只能读到文件修改时间，而 CAS 内容不可变，修改时间恒早于该副本真正进入回收站的时刻；只有元数据里没有该副本（库外移入回收站）才采用磁盘修改时间。
- 清空回收站（`src/commands/emptyTrash.ts`）仍基于元数据增量执行，不做全量磁盘扫描。
- **恢复目标目录由引用类型决定**：`restoreIfTrashed`/`load` 接受可选允许目录列表，副本所在目录不在列表内时迁移到列表第一个目录，列表为空/未提供则原位恢复。恢复命令（`restoreReferencedFiles`）按引用类型计算列表——存在 `ipfs://` 引用 → 主存储目录；仅 `internal.ipfs-locked:` 锁定引用 → 下载目录列表（`downloadDir` 与各网关 `downloadDir` 去重）；下载目录为空则不传（原位）。触发笔记自身以 `ipfs://` 引用时短路跳过全库查询（`ReferenceManager.hasIPFSReference`）。
- **重建索引对账**（`src/commands/rebuildIndex.ts`）：以磁盘为权威，分两阶段清理残留，内存只保留已产出 CID 的集合（不把全部对象加载进内存）——① 流式扫描磁盘副本：按「目录的正常区 → 同目录回收站 → 下一目录」顺序遍历，某 CID 首次出现时就地探测它在**尚未扫描目录**中的副本（已扫描过的目录不回查），凑成一条完整记录立即产出并记为 `lastVisitedAt = scannedAt`，之后在其它目录再遇到同一 CID 直接跳过；② 遍历元数据，凡 `lastVisitedAt` 早于 `scannedAt`（磁盘已无该 CID 任何副本）的记录：仍被引用则保留记录与 filename/format 并清空副本状态退出回收站，否则整体删除。这样 `.trash` 文件被外部删除后回收站不再残留。
- IndexedDB schema 为 v2（`DB_VERSION=2`）：v1 的 `trashedAt` 在升级时迁移为 `copies`（用空字符串占位“未知目录”），**迁移惰性化**——不在 `onupgradeneeded` 里遍历数据（会卡住），改为运行时 decode/merge 兼容。

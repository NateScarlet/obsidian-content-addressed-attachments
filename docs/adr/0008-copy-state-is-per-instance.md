# 副本状态按实例记录，同一目录可同时有正常副本与回收副本

一个 CID 可以在多个目录各有一份物理副本，而回收站就在所属目录内的 `.trash/` 下
（`dir/.trash/XX/{cid}.data`）。因此同一目录里完全可能同时存在一份正常副本和一份回收副本
——它们是两个独立实例，各有自己的回收时间。用记录级单一 `trashedAt` 字段描述整条记录
无法表达这种状态，早期 IndexedDB schema v1 正是这么做的。

改为 `copies: [{ dir, trashedAt? }]` 的 per-instance 模型：每个物理副本一条实例，按
「目录 + 是否回收」定位槽位（`src/utils/casCopies.ts` 的 `mergeCopies`）。回收站判定因此是
「任一副本实例处于回收状态」（`isCASObjectTrashed`），而不是「整条记录被回收」。

由此确定写入规则：**落库时不扫描磁盘判定回收状态。** `index` / `save` 保留已有副本状态
（本次没涉及的实例原样带过），`trash` / `load` / `restoreIfTrashed` / `deleteIfTrashed` 因为
本身已经动了磁盘，才按磁盘操作结果重建副本状态。回收时间以元数据既有值为准——磁盘只能读到
文件修改时间，而 CAS 内容不可变、`rename` 不改 mtime，磁盘值恒早于副本真正进入回收站的
时刻（见 [ADR-0002](./0002-rebuild-index-streams-by-probing-remaining-dirs.md)）。

**Considered Options**:

- 回到记录级单一 `trashedAt`：无法表达同目录的正常与回收并存，`load` 会把仍在正常区的文件
  判成已回收、或把回收副本当成正常副本，否决。
- 每个副本只记 `dir`，回收状态另置于记录级：等价于上一条，否决。
- 落库时总是扫描磁盘重建全部副本状态：每个写入多出 O(目录数) 次 stat，把写侧热路径交给磁盘
  延迟，也让「元数据写入不应阻塞只需磁盘结果的操作」难以维持（见
  [ADR-0007](./0007-disk-is-the-only-source-of-truth.md)），否决。
- v1 → v2 在 `onupgradeneeded` 里用游标遍历迁移 `trashedAt` → `copies`：IndexedDB 的
  versionchange 事务在请求排空后立即 inactive，链式游标遍历会让 `open` 永久 pending（表现为
  所有查询挂起、库目录被占用、进程无法退出），否决。改为惰性迁移：升级只删掉 v1 的 `trashedAt`
  索引，数据在 decode 时转成占位 `copies`（空目录字符串保守表示「该 CID 可能存在于未知目录
  的回收站副本」），`merge` 保存时逐步收敛为精确副本状态。

**Consequences**:

- 合并副本状态是所有写入的必经点（仓库层 merge），因此「保留既有回收时间」的语义对
  `save` / `index` / `trash` / `load` / 重建扫描统一生效，调用方无需各自实现。
- 恢复的目标目录由引用类型决定：`restoreIfTrashed` / `load` 接受可选的允许目录列表，副本所在
  目录不在列表内就迁移到列表第一个目录，列表为空或未提供则原位恢复；恢复命令按引用判定给出
  列表（见 `src/commands/restoreReferencedFiles.ts`）。
- 清空回收站与重建索引都以元数据的副本实例为准；把 `.trash` 里的文件在插件外删掉后，下次
  对账会发现磁盘已无该 CID 的回收副本，回收站不再残留。
- 惰性迁移留下的占位副本需要一次副本状态变更（如重建索引）才会收敛为精确值。
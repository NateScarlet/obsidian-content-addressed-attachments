# 用有界保序并发原语取代无上限 Promise.all

万级附件的 vault 中，增量扫描（`ReferenceManager.doIncrementalScan`）对新装插件后的整库文件直接 `Promise.all`，一夜之间启动上万个读取与元数据写入任务，打满内存与 IO，界面长时间无响应；同类无上限并发散落在单条笔记的链接索引、重建索引、DOM 批量补丁等处。项目里唯一的并发原语 `orderedParallelFilter` 只覆盖「过滤」一种场景，其他场景只能退回 `Promise.all`。

改为泛化出一个有界保序并发原语 `orderedParallelMap`（`src/utils/orderedParallelMap.ts`）：消费同步或异步可迭代的源，以 `limit` 为并发上限对每个元素执行「投影」（返回异步可迭代，可产出 0..n 个值），按源顺序交付，支持早停与取消。`orderedParallelFilter` 作为只有单一场景的旧接口被删除（内部接口变更必须改完所有调用者，不保留兼容层）。纯副作用调用方返回 `EMPTY_PROJECTION`（规范的空产出），`drain()` 用于只等完成、不关心产出的调用方。

**`limit === 1` 走串行快路径**：逐项取源 → 投影 → 产出，不建槽位、不做竞态，省去批次开销；顺序、错误位置与取消语义与并发路径一致。

**启动节拍为按批，而非自由 worker 池。** 每批并发取至多 `limit` 个源元素，并在同一个同步块内启动该批全部投影。这不是风格选择：合并批（`CoalescingBatch`）的收益依赖「同一注册窗口内并发到达的请求」，自由 worker 池会让相邻请求散落到不同微任务，元数据写入与引用计数查询的合并随即失效，事务数从 ~30 退回 ~10k。代价是批内最慢的一项会押住整批——而按 `limit` 的语义，同一批本来也要等它。

**`limit` 因此是双重含义**：既是并发上限，也是合并批宽。取值写在每个调用点而非集中默认（`doIncrementalScan` 64、`loadFileContent`/`process` 8、`applyBatch`/`rebuildIndex` 1000）；`CASMetadataImpl.find` 的 1024 是刻意的大批宽，它限制的是「合并批宽」而非独立任务数，因此豁免。原语另外导出 `DEFAULT_PARALLEL_LIMIT = 8` 供取常规并发度的调用点显式引用——它是调用点可选的取值来源，不是原语的隐式默认（`limit` 仍为必填参数）。

**Considered Options**:

- 保留 `orderedParallelFilter` 并在其上加 map/forEach 入口：旧接口只覆盖过滤，泛化后成为冗余的第二套入口，且「向下兼容保留旧接口」违反完整重构规则，否决。
- 投影返回数组（`Promise<Out[]>`）而非异步迭代器：项目内没有「单项产出极多且耗时」的场景，数组更简单；但并发上限与缓冲区大小的表述都依赖「产出序列」这一概念，迭代器形态让每项只缓冲一个未交付输出、边界更清晰，且与 Go 参照 `ParallelConcatMap` 的 1→n 语义一致，否决数组形态。
- 自由 worker 池（谁空谁起，贴 Go 的每项一 worker）：单槽慢不押别人，但破坏合并批的注册窗口（见上），否决。
- 额外提供 unordered 变体：省下的缓冲上限就是 `limit`，收益微乎其微，却要让「同批同步块启动」的保证维护两份，否决。
- `main.ts.process` 保持 `Promise.allSettled` 的静默元素级吞错：`console.*` 在生产构建被剥离，静默吞错等于没有反馈，违反「日志不是可见反馈」，否决。

**Consequences**:

- 增量扫描的进度序号从「完成序」变为「源序」（序号与文件名一一对应）；进度回调改由产出顺序驱动。
- `rebuildIndex` 的 `pending`/`flush` 分块逻辑与 `DEFAULT_MERGE_BATCH_SIZE` 导出被删除（改由原语的 `limit` 接管），外部可观测语义（`onProgress` 次数与累计值、`scanned` 计数）不变。
- `main.ts.process` 的行为变更：元素级错误不再被静默吞掉，改为「元素内隔离 + 窗口内合并的单条 Notice」。为此新增可注入的 `CoalescedNotice`（`main.ts` 的实例挂在插件 `DisposableStack` 上随卸载释放）。
- `restoreReferencedFiles` 原有的模块级 500ms 防抖与定时器一并改为复用 `CoalescedNotice`（同一合并通知机制只有一份实现）。该实例仍是模块级、无生命周期所有者，与改动前一样依赖定时器自行触发；把它纳入可释放的生命周期需要经 `RestoreReferencedFilesOptions` 注入并级联到 `emptyTrash` 与 `ReferenceManager`，属独立改动。
- 原语返回手写迭代器而非裸 `async function*`：裸生成器的 `return()` 请求要等其恢复执行才被处理，投影阻塞在 `await` 上时会让插件卸载挂住；手写迭代器在 `return()` 时主动打断主循环的阻塞等待。外部可观测语义（顺序、错误、取消）与裸生成器一致，仅早停不再挂起。
- 各处「串行 await 循环」（`applyBatch` 的 deletes、`restoreReferencedFiles`、`cleanUnreferenced`、`findFilePath`）本次只加 `// TODO` 标记：它们无并发爆炸风险，并发化属于性能改造而非本次重构。

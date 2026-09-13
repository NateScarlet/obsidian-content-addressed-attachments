# 移除 mergeBatch：合并批统一承载写入与查询的按批模式

附件元数据写入原先并存两个入口：低频单条 `merge`（每条一个 IndexedDB 读写事务）与批量 `mergeBatch`（调用方自行分块、整块一个事务、每块派发一次聚合批量事件）。万级附件的空库首次扫描（重建索引或增量扫描大量链接）时，`CASImpl.index` 仍走逐条 `merge`，每条一个事务，IndexedDB 被拖垮、界面冻结；且存储层并存两套入口、UI 并存两套事件，调用方必须自己分块、自己选择入口，界面需要同时维护两条订阅逻辑。

改为把「批量」从调用方责任移回机制内部：从 `CASMetadata` 接口移除 `mergeBatch`，`merge` 单条调用入队合并批（`src/utils/CoalescingBatch.ts`，go 参照 `runInBatch`+`loop` 收集循环），同一注册窗口（同步块）内并发到达的请求自动合并为一个读写事务；达到批上限（1000，与旧块大小一致）才切新批，无积压时单条零等待（maxWait 而非 minWait）。调用方只需并行调用单条 `merge`（重建索引按块 `Promise.all`、写侧同步服务同批 `Promise.all`）。`casMetadataBatchSave` 事件删除，内部批对每个变更对象派发 `casMetadataSave`，UI 只监听该事件并 1 秒节流。

`CoalescingBatch` 是通用合并批机制，写入侧与查询侧共用一套：写入侧每个请求独立条目、逐项结果；查询侧（`ReferenceManager.mergedEntryCount`）通过合并键（`keyOf = cid`）把同 cid 请求去重合并为一个执行条目、多 waiter 共享一次查询结果，并按验证语义（skipVerify/verify）分队列（`batchKeyOf` 内联于 ReferenceManager）。原先查询批自带的 `ReferenceLookupBatch` 容器类与策略纯函数（`mergeBatchPolicy`）不再需要，删除。

合并策略为 go 形态：收割时把队列中所有可执行请求拉入同一批（`abort = len(batch) == maxBatchSize`），不存在「`pending<=1` 即提前收割」的语义——探针验证该语义会把同一同步块的突发请求拆成逐个独立批（每请求一个事务），合并完全失效。

事务信号按 go 语义：内部批执行使用存储层自己的后台 `AbortController`（`[Symbol.dispose]` 时 abort，关闭插件卸载时多版本竞争写同一 IndexedDB 的窗口）；调用者 signal 只在收集阶段生效（join 时已 aborted 不入队、执行前已 aborted 跳过），执行阶段不支持调用者取消——共享事务不被个别调用方中止拖垮。

**Considered Options**:

- 保留 `mergeBatch`，只把增量扫描也接到批量入口：存储层与界面仍并存两套入口/事件，调用方仍需感知并分块，未解决「调用方自己分块」的结构问题，否决。
- 调用方不并行逐条、改串行 `merge`：串行调用时批内永远只有自己，合并收益完全消失，否决。
- minWait 凑批（等一小段时间攒批再执行）：无积压的单条写入被强加延迟，违背「无积压零等待」，否决。
- 查询批维护独立容器 `ReferenceLookupBatch` + 策略纯函数 `mergeBatchPolicy`（`pending<=1` 即收割）：探针证实该收割语义把同步突发请求拆成逐个独立批，合并失效；且批逻辑散落两处（容器各写各的、仅策略共享），否决——统一为一个 `CoalescingBatch`。
- 类名沿用 `MergeBatch`：该类并非 merge 方法专用（查询侧同样使用），与 CONTEXT 术语 _Avoid: mergeBatch 冲突，否决，改用 `CoalescingBatch`。

**Consequences**:

- `merge` 调用语义不变（partial 字段保留既有值、副本以传入为准、didCreate 逐调用者返回），批量写入不改变任何数据语义；同一批内同 cid 不去重，逐 op 在同一事务内按序 get→put，后到者覆盖先到者。
- 低频写入路径（保存/回收/恢复单条）的 UI 节点更新从「立即」变为「最多延迟 1 秒」——这是「UI 只监听 `casMetadataSave` 并节流 1 秒」的既定取舍。
- 内部批执行阶段不支持调用者取消：rebuildIndex / 写侧同步服务的中止实际发生在入队前（循环内 `throwIfAborted` / drain 提前返回），入队后中止窗口极小；插件卸载时由 `CASMetadataImpl[Symbol.dispose]()` 中止后台控制器，在飞事务仍会被中止。
- 引用查询批（`ReferenceManager.mergedEntryCount`）改用同一 `CoalescingBatch`，修正此前每请求独立批的问题；`skipVerify`/默认验证的批归属（`batchKeyOf`）与同 cid 去重共享语义不变。
- 关闭 issue #37 的原始方案；「事务数从 3 万降到 ~30」「进度条卡顿根因（逐条事件 + 热路径日志）」目标由本方案继续达成，调试 `console.log` 随重构移除。

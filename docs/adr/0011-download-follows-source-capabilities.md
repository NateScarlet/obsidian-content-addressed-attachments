# 下载通道按来源能力选择，峰值内存与分块同阶

远端下载原先只有一条实现：`requestUrl` 取回完整响应体 → 包成 `File` → 交给 CAS 保存。`requestUrl`
在 promise resolve 之前就把整个响应收进原生层，再跨桥交给渲染进程（Android 上还多一份 base64
中转），对象多大、峰值内存增量就多大。实测 Android Obsidian 解析一个 126MB 的对象会直接被杀进程
（issue #55），而桌面端因为本地命中、根本不触发下载，复现不到。

因此我们决定：**下载先按来源能力选择通道，任何通道都不把整个对象一次性读进内存。**

1. `fetch` 的响应体可读（即源允许 CORS）→ 逐块流式读取；这是首选，且可随 `AbortSignal` 取消。
2. 否则用一次带超时的 `HEAD` 预检 `accept-ranges` 与 `content-length`。`requestUrl` 不可取消，
   HEAD 的超时只能是「放弃等待该来源」，不能让挂住的 HEAD 拖住整体解析。
3. 支持 `Range` → 按块请求，每块校验 `Content-Range` 的起止、总长与实际字节数；总长取自第一块
   而不是 HEAD 的 `content-length`。三者不一致属于内容级失败，换源没有意义。
4. 不支持 `Range`（或 HEAD 失败）→ 仅在允许整包、且总长未超过可配置上限时沿用整包下载；
   超限、上限配置为 0（永不允许整包）、或总长未知但整包已被禁止时直接失败，
   **不发出会带回整包 body 的请求**。

配套地，CAS 的保存入口收敛成「字节来源」（`ByteSource`：`open()` 返回异步迭代器），不再收
`File`：写入临时文件、增量计算 SHA-256、完成后改名到正式路径，写盘按不小于 4MB 的批次合并
（`fetch` 流的块常见只有数 KB，逐块写盘会拖垮移动端 IO）。

**Considered Options**:

- 保留 `requestUrl` 整包下载，只在移动端按大小限制：对支持 CORS 或 Range 的源毫无改善，等于把
  可用性交给来源配置，否决。
- 把全部下载换成 `fetch`：带鉴权头的网关会被 CORS preflight 拒绝，移动端跨域请求也只能走原生桥
  （ADR-0001 的理由仍然成立），否决。
- 分块逻辑内联在 `URLResolver`：通道选择与 CAS 落盘两件事互相牵扯，且普通 HTTP 解析要复用同一套
  通道，否决。
- 给 `save` 加 `File | ByteSource` 联合类型：等于让 CAS 认识两种来源形态、内部再分支，否决。

**Consequences**:

- 本文覆盖 [ADR-0001](./0001-probe-uses-fetch-download-keeps-requesturl.md) 中「完整下载继续使用
  `requestUrl`」的结论；探测仍用 `fetch` + `no-cors`，`requestUrl` 保留为 Range 与整包兜底通道。
- 临时文件写在目标目录下的 `.incoming/`：目录名不是 2 字符分片目录，重建索引与下载目录清理的
  遍历都不会把它当成副本；中途失败、失败换源与取消都会删除临时文件。
- 整包下载仍会把对象读进内存，因此有可配置上限（默认 32MB，≤0 表示永不允许整包）。来源同时
  无 CORS 与 Range 且体积超限时给出可读错误，而不是冒内存风险。
- 增量 SHA-256 由仓库自实现（`src/utils/streamingSha256.ts`）：Web Crypto 的 `crypto.subtle.digest`
  与 multiformats 的 hasher 都只接受完整缓冲区，等价于把整个对象读进内存。

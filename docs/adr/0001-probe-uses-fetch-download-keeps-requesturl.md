# 探测层使用 fetch（no-cors HEAD），完整下载保留 requestUrl

来源解析在完整下载前需要先用探测排除慢速/不可达来源，避免一个挂住的来源拖住同批全部请求。Obsidian 的 `requestUrl` 不支持超时与取消（`RequestUrlParam` 无 timeout/signal 字段，官方无支持承诺），无法实现"可中途放弃的探测"；而渲染进程的 `fetch` 支持 `AbortSignal`，配合 `SingleFlightGroup` 的引用计数可让探测随最后一个放弃的调用者真正中止。因此探测统一用 `fetch(method: HEAD, mode: "no-cors")` 实现：no-cors 模式不做 CORS 判定，收到任意 HTTP 响应（含 404/504）即视为 Host 可达并记录 RTT，仅网络层失败才 reject——恰好是"可达性"的语义，且不需要区分 CORS 拒绝与网络错误。

完整下载（GET）继续使用 `requestUrl`：GET 不在本次改造范围；它依赖 requestUrl 的 CORS 豁免（带自定义鉴权头的网关在 fetch 下会被 preflight 拒绝），且移动端跨域请求本就只能走 requestUrl。代价是下载请求不可取消，首个成功结果产生后被遗弃的下载请求无法真正中止——已接受此残余风险。

**Considered Options**:

- 探测也用 requestUrl + `Promise.race` 超时：只能"不再等待"，请求本身仍占用传输资源，未解决排队问题，否决。
- GET 迁移到 fetch + AbortSignal：可真取消，但 CORS preflight 会破坏现有带鉴权头的网关配置，且移动端不可用，超出本次范围，否决。
- `Cache-Control: only-if-cached` 探测：规范保证快速返回 412，但语义是"是否存在缓存"（内容存在性），与"Host 可达性"的探测职责不符，否决。

**Consequences**:

- 探测请求按 Host 去重共享结果（`SingleFlightGroup`），批内任一探测结论适用于同 Host 本批全部来源；探测不含 CID 存在性信息，存在性由 GET 后的 CID 校验判定（既有机制）。
- 探测失败（网络层 reject）的来源本轮出局，不回退 requestUrl。
- 未来若将 GET 迁移到可取消的 fetch，需重新引入 CORS 模式探测以区分"可 fetch 下载"的来源，届时属那一次改动的范围。

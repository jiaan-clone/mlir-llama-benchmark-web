# Buddy Responses SSE：分步 Agent 提示词

建议分为 **6 步**，按顺序执行。每一步只实施该步范围，通过验收后再进入下一步。
本次只为 Buddy 增加 `/v1/responses` 流式调用和页面展示，不改成 Chat Completions，
不让浏览器直连 compute_server 动态分配的 buddy-server 端口。

```text
浏览器 -> ruyi-serving POST /v1/responses (stream:true)
       -> compute_server StreamResponse
       -> buddy-server POST /completion (stream:true)
```

## 当前基础与协议

编写本文时，前端已经有 `requestStream`、SSE data 行解析器、统一 `EngineResult`
和可选 `BackendClient.streamInference`，但 Buddy client 与页面仍使用非流式。
已有 llama 流式 client 尚未接入页面，不应把它当成已完成的 UI 能力。

ruyi-serving 当前 Responses SSE 示例：

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"output_index":0,"content_index":0,"delta":"Hello","logprobs":[]}

event: response.completed
data: {"type":"response.completed","sequence_number":8,"response":{"status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6},"ruyi":{"execution_metrics":{"latency_ms":250,"time_to_first_token_ms":40,"tokens_per_second":8}}}}

```

这只是字段位置示例，不是完整成功响应；实际完整文本应来自终止事件中的
`response.output[].content[].text`。实施时仍须根据当前后端源码和测试复核契约。

- 文本增量位于 `response.output_text.delta` 的顶层 `delta`，不是 `choices[].delta.content`。
- 正常终止事件为 `response.completed`、`response.incomplete`、`response.failed`。
- 错误还可能通过 `event: error` 和顶层 `error` 对象返回。
- Responses SSE 不发送 `[DONE]`，不能等待它才能完成。
- 终止事件的 `response.usage` 和 `response.ruyi.execution_metrics` 是完整指标来源。
- 首 token 的浏览器观测值指首个非空文本 delta，不代表模型实际生成的第一个 token。
  一个 delta 可能包含多个 token，不能按 SSE 事件数或字符数估算 token 用量。

## 使用方法

每次把下面的“全局约束”和当前步骤的完整提示词一起交给 agent。
每步结束先检查 diff，再执行测试；交接文件列表、已确认的协议、测试结果和遗留问题。
第 1～3 步先完成可独立测试的客户端能力，第 4 步接入页面，第 5～6 步完成指标核验、
文档与真实服务验收。本文是实施说明，不表示这些步骤已经完成。

## 全局约束

```text
你正在修改 mlir-llama-benchmark-web 项目，请只实施当前步骤。

1. 先阅读 AGENTS.md（若存在）、README.md、docs/ruyi-serving-integration.md、
   docs/llama-direct-integration.md、相关源码和测试，并检查 git status。
   后端资料不足时说明限制，不要臆测字段。
2. 如果同级存在 ruyiai-serving 仓库，只读核对 docs/responses-api.md、
   docs/server-process-runtime.md、api_server/application/response_mapping.py、
   api_server/application/inference.py 及相关流式测试。
   该后端仓库不在修改范围内；缺失时以用户提供的当前版本契约为准。
3. 模块化编码：HTTP 生命周期、通用 SSE 解码、Responses 协议解析、ruyi client、
   指标计算、React 状态协调、UI 展示分别承担单一职责。
   不要把协议与 reader 循环堆进 App.tsx，不要复制一套几乎相同的应用。
4. Buddy 保持通过 ruyi-serving POST /v1/responses 调用，seed 保持在
   ruyi.backend_options 中。保留现有非流式 runInference 和 api.ts facade。
5. 保留 llama 非流式行为和现有流式 client 导出及测试；除共享基础修复外，
   不扩大到 llama 流式 UI 或后端进程管理。
6. 不引入新的运行时依赖。使用 Fetch、ReadableStream、TextDecoder、AbortController。
   若需要新的开发测试依赖，先说明必要性并取得用户同意。
7. 外部 JSON 必须运行时校验。已知事件字段损坏应有明确错误，未知事件可安全忽略。
   不得把 malformed JSON、缺少终止事件或意外断连静默当成成功。
8. 用户取消保持 AbortError；超时是明确的 ruyi-serving 超时错误，不伪装成用户取消。
   成功、异常、取消、超时均须清理 reader、监听器、计时器和待发布的 UI 更新。
9. 终态只发布一次。非流式回退由用户关闭流式开关后重新运行，不要在部分输出、
   错误或取消后自动重发请求，避免重复推理和误导性能数据。
10. 保留单侧可用即能单独运行、Buddy 后 llama 的顺序对比、统一参数和主题布局。
    不做无关样式重写、不改用户现有 .env、不输出 API key 或提交模型与本机路径。
11. 保留已有用户改动，不执行破坏性 git 操作，不自动暂存或提交 commit。
12. 每步运行 git diff --check、npm run test -- --run、npm run build、npm run lint。
    区分既有失败与本次失败；不能将未执行的检查描述为通过。
13. 最终回复给出修改文件、实际检查结果、已知限制和下一步交接事项。
```

## 第 1 步：完善共享 SSE 与 HTTP 生命周期

```text
任务：为 Responses 命名 SSE 建立可靠的共享基础，暂不改变 Buddy 请求和页面行为。

请完成：
1. 检查 src/services/httpClient.ts、sseParser.ts、llamaClient.ts 和 src/types.ts。
   复用已有 requestStream 与 SSE 基础，不新建平行 HTTP 实现。
2. 为 SSE 解码提供结构化事件，例如 { event: string | null, data: string }。
   通用解码器只处理 SSE framing，不理解 response.*、choices 或后端名称。
   保留已有 string[] data 接口的兼容包装，或同步迁移所有调用方及相关测试。
3. 处理 LF、CRLF、单 CR、多行 data、注释、空 data、可选 event 字段及未知字段。
   必须覆盖 CR 和 LF 分属两个 chunk 的情况，避免提前生成错误的空行/事件。
   正常仅在事件边界派发；EOF 残余行/事件的处理须有明确策略，
   不把残余半条 JSON 自动视为合法事件。UTF-8 使用 TextDecoder 增量解码。
4. 检查 requestStream 的计时器和父 signal 是否覆盖整个响应体读取过程。
   修复 HTTP 错误正文读取失败时的 cleanup 泄漏；区分取消和超时。
   若抽取通用 reader 工具，放在独立模块，不包含任何模型协议。
5. 将 LlamaStreamUpdate 的通用部分抽为 EngineStreamUpdate，保持旧名称类型别名
   和 StreamUpdateHandler 兼容，避免让 Buddy 协调代码依赖 llama 专属类型。
6. 添加测试：命名事件、data-only llama 事件、任意切块、跨 chunk CRLF、
   多行 data、注释、UTF-8 字节切分、HTTP 非 2xx、错误正文读取失败、
   请求前已取消、读取中取消、读取中超时，以及 cleanup 幂等性。

验收：
- 原 llama 流式与非流式测试全部通过，共享改动不破坏已有协议解析。
- 自动化测试、构建、lint、diff 检查通过。
- App.tsx 和 Buddy 的实际请求仍为非流式。

交接：记录 SSE 事件接口、EOF 策略、reader 工具接口和 cleanup 所有权。
```

## 第 2 步：实现 Responses 流式事件解析与聚合

```text
任务：实现独立、无 React 和网络依赖的 Buddy Responses SSE 协议解析模块。

请完成：
1. 只读确认当前 ruyi Responses 契约，新增例如
   src/services/ruyiStreamParser.ts 及对应单元测试。
   通用 SSE 解码留在第 1 步模块，llama 的 choices 协议留在 llama 解析器。
2. 将 SSE event 名称和 JSON type 映射为类型安全的事件联合。
   明确二者缺失/冲突的处理；同一事件名称与 type 冲突应报协议错误。
3. 识别 response.created/in_progress、response.output_text.delta/done、
   response.completed/incomplete/failed 和 error。
   其他合法生命周期事件可忽略，但不能因缺少 choices 而丢弃 Responses delta。
4. delta 只拼接顶层字符串 delta。生命周期、空 delta 不触发首文本计时。
   区分 output_index/content_index，避免多个文本部分串错。
   done 和终止事件中的完整文本用于校准，不要再追加导致双倍输出。
5. 终止事件从嵌套 response 解析最终 EngineResult，复用已有 parseRuyiResponse。
   保留 incomplete 的兼容语义和 finish reason，不把 token 上限当成服务崩溃。
   failed/error 提取错误信息；事件类型与 response.status 必须一致或明确报错。
6. 明确聚合终态规则：首个合法终态生效，此后不再追加或发布结果。
   EOF 不是成功终态；没有合法终止事件时报告流中断。
   Responses 不依赖 [DONE]。sequence_number 可用于去重/诊断，
   但不要假设对外所有序号连续，也不要拒绝后端可能使用序号 0 的 error 事件。
7. malformed JSON、已知 delta 字段类型错误、终止 response 缺失应报错。
   未知事件安全忽略；可选 usage/metrics 缺失不能导致崩溃。
8. 用当前后端字段编写本地 fixtures，测试多段文本、空 delta、done 校准、
   completed/incomplete/failed/error、重复终态、终态后 delta、未知事件、
   字段损坏和无终态 EOF；不访问真实服务。

验收：
- 所有解析/聚合逻辑可用纯函数或独立状态对象测试。
- 最终 response 文本不会被重复拼接，failed 和截断流不会返回 success。
- 自动化测试、构建、lint、diff 检查通过；页面行为仍不变。

交接：给出解析事件类型、聚合接口、终态规则和完整 fixture 示例。
```

## 第 3 步：接入 Buddy 可取消流式客户端

```text
任务：在 ruyi client 提供 streamRuyiInference，暂不接入 React 页面。

请完成：
1. 在 ruyiClient.ts 挂接可选 BackendClient.streamInference，并暴露稳定的
   streamRuyiInference 导出。reader/聚合较复杂时使用独立 ruyiStream.ts，
   保持客户端入口简洁，不继续堆成单个大文件。
2. 复用 requestStream，发送 POST /v1/responses、Accept: text/event-stream，
   使用现有 baseUrl/apiKey/Authorization，请求体保持：
   model、input[].content[].input_text、max_output_tokens、temperature、
   ruyi.backend_options.seed，仅将 stream 改为 true。
   不改成 messages/max_tokens，不写死模型 ID 和服务地址。
3. 校验响应 Content-Type 支持 text/event-stream（允许 charset 参数）。
   错误响应解析沿用共享 HTTP 层；2xx 但返回 HTML/JSON 也要明确报协议错误。
4. 通过第 1 步解码和第 2 步解析模块读取流，回调只交付统一进度数据。
   从请求开始到首个非空文本 delta 记录浏览器观测 TTFT，
   从请求开始到终态记录 wall-clock；用可控时钟精确测试这些值。
5. 最终 usage 和 ruyi.execution_metrics 优先从终止 response 读取。
   缺失延迟时使用 wall-clock，缺失后端 TTFT 时使用观测 TTFT；
   后端 TPS 优先，否则只在真实 output_tokens 与有效延迟存在时估算。
   缺失 token 用量保留 null，不按 delta 数/字符数伪造。
6. 首个合法终态立即完成，不等待服务器关闭连接；EOF 无终态报错。
   请求已取消或读取中取消抛 AbortError；总请求超时返回 ruyi-serving 超时错误。
   各出口用 finally 取消/释放 reader，并清理计时器和监听器。
7. 保持原 runInference(stream:false) 和 api.ts 兼容行为；不自动重试或降级重发。
8. mock fetch/ReadableStream 测试 URL、请求体、Authorization、增量回调、
   首文本计时、终态后连接未关闭、无终态 EOF、HTTP/流内错误、超时、
   取消与清理。取消测试要实际断言资源释放，而不只是检查错误名称。

验收：
- Buddy 可在测试中实时交付文本，并返回统一 EngineResult。
- 非流式请求体和解析结果保持兼容，llama 回归测试通过。
- 自动化测试、构建、lint、diff 检查通过；App.tsx 仍只走原调用路径。

交接：给出调用签名、进度数据、最终指标优先级和异常语义。
```

## 第 4 步：抽取运行协调并接入页面

```text
任务：将 Buddy SSE 接入单独运行和顺序对比，保留非流式回退与现有布局。

请完成：
1. 阅读 App.tsx 的 executeBackend、runBackend、runComparison、results、
   engineStatuses、runState 和取消逻辑。把运行协调抽为 useInferenceRunner
   或现有风格的 hook + 可独立测试的 reducer/纯协调器。
   不在 JSX 中解析 SSE，不复制两套单独运行/对比流程。
2. 新增明确的“Buddy 流式输出” checkbox/toggle，默认关闭以保留现有行为。
   启用后只有 Buddy 走 streamInference；llama 保持当前页面非流式行为。
   运行期间禁用模式切换，并冻结本次 modelId、Prompt 和采样参数快照。
3. 进度回调增量更新 Buddy 文本和观测 TTFT，engine/run 状态一直保持 running，
   只有终态才完成。若当前 EngineResult 不表达中间态，使用独立进度状态，
   不让摘要把中间结果误认为完成。
4. 对比严格等待 Buddy 终态后才启动 llama；两侧使用同一参数快照。
   保留原有单侧错误仍尝试另一侧的规则，但用户取消后绝不启动第二侧。
5. 修正针对流式进度的取消逻辑：即便已有 partial result，也要标记 cancelled，
   不能继续沿用 currentResult ?? cancelledResult 导致 partial 状态残留。
   保留并展示已生成文本，提示其被取消/失败；未启动的第二侧状态要一致。
6. 防止旧请求的晚到回调、节流队列或 finally 覆盖新请求状态。
   组件卸载取消当前运行，终态/取消后不能再接受旧进度。
   如做节流，首文本指标及时发布，最终状态必须 flush，取消必须丢弃待发布更新。
7. ResultCard 只负责展示进度、文本、终态、错误和取消提示。
   刷新健康状态不能清空推理结果；单侧可用仍可独立运行。
8. 测试开关关闭/开启、单侧可用、参数快照、增量展示、顺序执行、
   首 token 前/后取消、取消后重新运行、晚到更新、卸载清理和流内失败。
   优先用现有 Vitest 对协调器测试，补实际 UI 验证；只有纯函数测试时
   要明确说明未覆盖真实 React hook/DOM，不能将其描述为页面级测试。

验收：
- 页面可在 Buddy 完成前显示文本和首文本指标，关闭开关恢复原非流式调用。
- 取消后无 running 残留，部分输出保留，新运行不被旧回调污染。
- Buddy 流式结束后才发 llama 请求，主题与响应式布局无无关变化。
- 自动化测试、构建、lint、diff 检查通过。

交接：给出 hook/协调器职责、状态转换、取消策略和实际页面验证情况。
```

## 第 5 步：统一指标规则并更新集成文档

```text
任务：核验 Buddy 流式指标和对比摘要，补齐文档，不新增其他功能。

请完成：
1. 检查 ruyi 解析器、流式 client、withWallClockFallback 和 ResultCard 的指标处理，
   将共享计算放入 metrics.ts 或独立的结果指标模块，避免重复与互相覆盖。
2. 对 token 用量校验有限、非负整数；延迟、TTFT、TPS 校验有限非负数。
   缺失字段不得当作 0；合法 0 保留，不因 truthy 判断触发错误回退。
3. 统一优先级：有效 ruyi execution metrics 优先；缺失延迟用请求 wall-clock，
   缺失 TTFT 用首个非空文本 delta 的浏览器观测值。
   已有后端 TPS 不被 wall-clock fallback 覆盖；没有实际 token 数时 TPS 为 null。
   tokensPerSecond 的 metricsSource 保持 backend/frontend/unavailable 兼容。
   明确该单一来源字段不能精确描述每项混合指标，不要误称全部指标都来自后端。
4. 对比摘要只使用两侧成功完成的有效 TPS；中间输出、cancelled、error 的 TPS
   不参与速度倍率。incomplete 保持既有结果语义，文档说明输出被 token 上限截断。
5. 补精确指标测试：后端优先、部分字段缺失、0、负数、NaN/Infinity、
   非整数 tokens、无输出、partial/cancelled/error 不生成误导性 speedup。
6. 更新 README.md 与 docs/ruyi-serving-integration.md，说明开关、默认非流式、
   手动回退、命名事件、三个终态、error 和 Responses 无 [DONE]。
   增加 curl -N POST /v1/responses 的 stream:true 示例，使用占位模型 ID/密钥。
7. 解释浏览器观测 TTFT 包括网络与排队，可能受网关文本过滤影响，
   不等同于后端 time_to_first_token_ms；SSE chunk 不是单 token。
   流式/non-stream 的 TPS fallback 均明确分母，Buddy/llama 不保证严格同口径。
8. 文档补 CORS、Authorization 预检、代理缓冲/压缩聚合导致增量延迟，
   以及请求超时、未收到终态、模型加载和取消后端传播的排查方法。
   保持当前环境变量名，不默认修改 Vite/Nginx 配置；确认有必要再讨论配置。

验收：
- 缺失指标显示不可用，而不是伪造 token 用量或吞掉已有后端 TPS。
- 文档命令与实际 endpoint、请求体、开关默认值一致。
- 不声称 llama 已接入流式 UI，不泄露 .env 内容或生产密钥。
- 自动化测试、构建、lint、diff 检查通过。
```

## 第 6 步：真实 SSE 联调与完整回归

```text
任务：验证已完成的 Buddy Responses 流式实现，不扩大功能范围。

请完成：
1. 运行 npm run test -- --run、npm run build、npm run lint、git diff --check。
   检查 git diff，报告既有问题与本次问题。
2. 安全读取当前前端配置，确认 ruyi 地址与 buddyModelId；不要打印 API key，
   不覆盖 .env，不编辑后端注册表，不擅自启动/重启/终止模型进程。
3. 如果真实服务可用，用很小的文本请求验证 /health、/v1/models 和
   POST /v1/responses(stream:true)。如服务不可用，记录限制，
   不将 mock 测试说成真实推理通过。
4. 检查 HTTP 状态、text/event-stream、Authorization、首个 delta 到达时间、
   正常三个终态之一、最终 response 文本/usage/ruyi metrics，以及无需 [DONE]。
   用正常 token 上限观察增量；DeepSeek 的极小预算可能没有可见回答，
   不把空文本直接视为 SSE 故障。
5. 页面验证：Buddy 非流式、Buddy 流式、llama 单独非流式、
   Buddy 流式后 llama 的顺序对比、首文本前/后取消、取消后立即重跑。
   实际观察取消是否传播到后端并释放当前计算；浏览器 AbortError
   不能单独证明模型已经停止。不要通过调用管理接口或 kill 进程伪造验收。
6. 用 mock/本地测试流覆盖真实环境不方便制造的异常：无终态 EOF、
   重复终态、非法 JSON、错误 response、长时间无 delta、读取超时、
   取消竞态和服务单侧不可用；不要破坏正在运行的真实服务制造故障。
7. 检查浏览器 CORS preflight 与代理缓冲。桌面/移动视口验证开关、长文本、
   指标和错误提示无重叠；有浏览器自动化工具时保留验证截图与实际交互结果。
8. 必要时启动前端开发服务器供用户验证，端口占用则选择其他端口，
   报告 URL 和该 origin 的 CORS 要求，不擅自停止已有服务器。
9. 输出简短验收报告：自动化结果、真实接口结果、页面路径结果、
   资源清理与后端取消证据、指标来源、未执行项和遗留问题。
   仅修复本需求引入的缺陷，不自动暂存或提交。

最终验收：
- Buddy 仍用 /v1/responses，流式和非流式均可运行。
- 增量文本实时显示，最终文本不重复，首文本指标有明确口径。
- completed/incomplete/failed/error/取消/超时均正确收敛，截断流不算成功。
- 单侧服务故障不阻塞另一侧单独运行，顺序对比与用户取消规则保持一致。
- reader、计时器、监听器、React 更新队列均正确清理，旧运行不能污染新运行。
- 自动化测试、构建、lint 通过，真实验证未完成的部分明确列出。
```

## 执行建议

每步保留独立、可审查的 diff，可在用户审查后分别提交。不要并发实施依赖前一步接口
的后续步骤。第 1 步特别关注共享 SSE 的回归，第 4 步特别关注取消竞态；这两处
比简单将 `stream:false` 改为 `true` 的改动风险更大。

完成第 3 步只表示 Buddy 流式 client 可用；完成第 4 步才表示页面已接入；
完成第 6 步并实际通过真实服务验证，才可以宣称端到端 Buddy SSE 联调通过。

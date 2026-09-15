# llama.cpp 直连改造：分步 Agent 提示词

本文把“llama.cpp 不经过 ruyi-serving、由浏览器直接调用 llama-server”的改造拆成多个可独立验收的模块。

目标架构：

```text
Buddy-MLIR: 浏览器 -> ruyi-serving -> buddy-server
llama.cpp:  浏览器 -> llama-server
```

建议先完成第 1～6 步的非流式版本，再单独评估第 7 步 SSE 流式输出。每一步都应在前一步通过测试后执行。除非某一步明确要求，不要顺手重写其它模块。

## 使用方法

每次把“全局约束”与当前步骤的提示词一起交给 coding agent。Agent 应在当前工作区直接修改代码，不要创建平行实现或复制整个应用。每一步完成后，先检查工作区 diff，再运行该步骤要求的测试，将结果和未解决的问题交接给下一步。

## 全局约束（每一步都适用）

```text
你正在修改 /home/king/mlir-llama-benchmark-web。

请遵守：
1. 先阅读当前实现、README、docs/ruyi-serving-integration.md 和现有测试，再开始改动；不要假设接口格式。
2. 采用模块化编码：HTTP 通用逻辑、ruyi-serving 适配、llama-server 适配、响应解析、React 状态协调分别放在职责单一的模块中。不要把所有逻辑继续堆进 App.tsx 或单个 api.ts。
3. 保留现有 Buddy-MLIR 功能和现有 UI 行为；除非当前步骤明确要求，不改变视觉样式和文案结构。
4. 不引入新的运行时依赖；优先使用浏览器 Fetch、AbortController 和 TypeScript 类型。
5. 不提交模型文件、密钥或本机绝对路径；不要把真实 API key 写进源码。
6. 对外暴露稳定、类型安全的函数；解析外部 JSON 时要对缺失字段、错误响应和未知格式安全处理，不能因类型断言导致运行时崩溃。
7. 不修改与本任务无关的文件，不执行破坏性 git 操作，不要自动提交 commit。
8. 每次改动后运行与本步骤相关的测试；最后至少运行 npm run test -- --run 和 npm run build。
9. 在最终回复中说明：修改了哪些文件、测试命令及结果、已知限制、下一步建议。
```

## 第 1 步：建立配置与领域类型边界

### 提示词

```text
任务：为双服务架构建立配置和领域类型边界，但暂时不要改变实际请求行为。

请完成：
1. 检查 src/config.ts、src/types.ts、src/api.ts、src/App.tsx 及 .env.example 的现状。
2. 将当前单一 API 配置拆成 ruyi-serving 和 llama-server 两组配置。建议支持：
   - VITE_RUYI_API_BASE_URL（兼容旧 VITE_API_BASE_URL 作为 fallback）
   - VITE_RUYI_API_KEY
   - VITE_LLAMA_SERVER_BASE_URL
   - VITE_LLAMA_SERVER_API_KEY
3. 为 ModelProfile 增加 llamaServerModelId 可选字段；未配置时兼容回退到 llamaModelId。不要破坏现有 VITE_MODEL_PROFILES_JSON。
4. 为后续客户端抽象定义必要的类型，例如后端服务标识、统一模型项、统一健康状态和统一推理结果。保持 EngineResult/InferenceMetrics 的兼容性，除非有充分理由扩展字段。
5. 把环境变量说明补充到 .env.example；不要修改运行时 API 调用逻辑。
6. 为配置解析增加单元测试：旧变量兼容、新变量读取、空值和非法 profile JSON 的 fallback。

模块化要求：配置解析、领域类型和测试职责分离；不要在 App.tsx 中读取 import.meta.env。

验收标准：
- npm run test -- --run 通过；
- npm run build 通过；
- 现有默认配置仍能启动；
- git diff 中没有模型路径、真实密钥或无关 UI 改动。
```

## 第 2 步：抽取通用 HTTP 客户端，保持 ruyi 兼容

### 提示词

```text
任务：抽取可复用的 HTTP 请求层，并让现有 ruyi-serving 请求继续工作。此步骤不实现 llama-server 协议。

请完成：
1. 将当前 api.ts 中的超时、AbortController、父 signal 透传、JSON/文本解析、HTTP 错误提取和认证 Header 逻辑抽取为独立的通用模块（例如 src/services/httpClient.ts）。
2. 通用客户端必须接收 baseUrl、apiKey、path、RequestInit 和 timeout，而不是依赖单一全局 apiBaseUrl。
3. 保留取消和超时语义：用户取消应抛出 AbortError；超时应返回明确的中文错误；网络错误消息不要再硬编码为只能连接 ruyi-serving。
4. 将 ruyi-serving 的 health、models、responses 调用迁移到独立的 ruyi client 模块（例如 src/services/ruyiClient.ts）。
5. 保留 src/api.ts 作为稳定 facade，或提供等价的兼容导出，避免 App.tsx 和现有测试一次性大面积改写。
6. 为通用请求层补充测试：成功 JSON、空响应、纯文本错误、非 2xx、超时、父 signal 取消、Authorization header。

模块化要求：通用 HTTP 层不得知道 BackendKind、ruyi 字段或 llama 字段；ruyi client 只负责 ruyi 的路径和请求/响应适配。

验收标准：
- 现有 src/api.test.ts 全部通过；
- 新增 HTTP/client 测试通过；
- npm run build 通过；
- 行为上仍只请求原来的 ruyi-serving 地址。
```

## 第 3 步：实现 llama-server 非流式适配器

### 提示词

```text
任务：新增 llama.cpp/llama-server 的非流式 OpenAI 兼容客户端，但先不要接入 React 页面。

请先根据本项目文档和当前 llama.cpp 版本可用资料确认接口，不要臆测字段；默认兼容：
- GET /health
- GET /v1/models
- POST /v1/chat/completions

请完成：
1. 新增独立 llama client 模块（例如 src/services/llamaClient.ts），使用第 2 步的通用 HTTP 客户端。
2. 实现 llama 健康检查和模型列表解析。兼容 /v1/models 返回 {data: [...]}，并安全处理 ready/id/owned_by 缺失。
3. 实现非流式 runLlamaInference：将统一 InferenceRequest 映射为 messages、max_tokens、temperature、seed、stream:false；model 使用 llamaServerModelId ?? llamaModelId。
4. 新增 llama 响应解析器（例如 src/services/responseParsers.ts），将 choices[0].message.content、finish_reason、usage.prompt_tokens/completion_tokens/total_tokens 映射到 EngineResult。
5. 解析 llama 的 timings（如果存在）。至少尝试映射 prompt_per_second、predicted_per_second；无法取得 latency 或首 token 时返回 null，让上层 wall-clock fallback 继续生效。
6. 错误响应要支持 error 为字符串或对象的 OpenAI 风格；不要让 choices 缺失导致异常崩溃。
7. 为请求体、成功响应、空 choices、错误响应、usage/timings 缺失和非法数值补充单元测试。测试中不得访问真实 llama-server。

模块化要求：llama 协议解析不可混入 ruyi 解析器；两个解析器最终只通过统一 EngineResult 交接。

验收标准：
- 所有现有测试和新增 llama client/parser 测试通过；
- npm run build 通过；
- 可以在测试中断言 llama 请求使用 /v1/chat/completions、max_tokens 和 messages；
- 此步骤结束时，App.tsx 的线上行为仍保持不变。
```

## 第 4 步：拆分后端状态并接入 React 运行流程

### 提示词

```text
任务：把 Buddy-MLIR 与 llama.cpp 的健康状态、模型发现和推理调用接入现有 React 页面，使两条链路真正独立。

请完成：
1. 检查 App.tsx 当前 healthStatus、models、modelsError、profileReady、runBackend、runComparison 的状态耦合。
2. 将健康状态、模型集合、加载标志和错误按 BackendKind 分开保存。可以抽取 useBackendStatus/useInferenceRunner 等 hook 或纯函数模块；不要继续把所有协调逻辑堆在 App.tsx。
3. refreshStatus 并行调用 ruyi health/models 与 llama health/models。一个服务失败不能覆盖另一个服务的 ready 状态。
4. 单独运行 Buddy 时调用 ruyi client；单独运行 llama 时调用 llama client；运行对比仍使用同一 prompt、maxOutputTokens、temperature、seed，并保持当前顺序执行和取消语义。
5. profileReady 必须同时要求两个后端对应模型可用；单独运行按钮只要求自身后端可用。
6. 继续使用现有 withWallClockFallback、speedup 和 ResultCard；如需修改，保持 EngineResult 统一结构。
7. 更新错误和可用性提示，使其能区分“无法连接 ruyi-serving”和“无法连接 llama-server”；顶部 API 信息至少能让用户看出两个地址。
8. 增加或更新 React/纯函数测试，覆盖：单侧不可用仍可单侧运行、双侧可用才可对比、刷新状态互不污染、取消请求后的状态恢复。

模块化要求：
- API 协议代码留在 services/client 模块；
- React hook 只负责状态协调；
- UI 组件只负责展示和事件绑定；
- 不复制两份几乎相同的 runInference 流程，优先通过 BackendClient 接口或函数映射复用。

验收标准：
- npm run test -- --run 通过；
- npm run build 通过；
- 在没有真实服务时，页面可分别显示两侧 unavailable，而不是统一显示 ruyi 错误；
- 现有 Buddy 单独运行、llama 单独运行、顺序对比和取消按钮逻辑均可编译。
```

## 第 5 步：补齐环境、CORS、安全提示和集成文档

### 提示词

```text
任务：为双服务直连模式补齐可运行配置和文档，不改变核心业务逻辑。

请完成：
1. 更新 .env.example，给出 ruyi-serving 与 llama-server 的地址、API key 和 profile 示例；说明 llamaServerModelId 的回退规则。
2. 更新 README.md：明确 Buddy 仍由 ruyi-serving 管理，llama.cpp 由独立 llama-server 提供；列出三个接口、请求协议差异、启动顺序和测试命令。
3. 新增或改写 docs/llama-direct-integration.md（不要删除原 ruyi-serving 文档），包含：
   - llama-server 启动命令示例（host/port/alias/model）；
   - curl 验证 /health、/v1/models、/v1/chat/completions；
   - 浏览器跨域 CORS、Authorization 和同源反向代理注意事项；
   - 非流式模式下 tokens/s、latency、首 token 指标的来源和限制；
   - 常见故障排查。
4. 检查页面中的所有“请求来自 ruyi-serving”文案，改成准确描述混合后端；不要泄露 API key。
5. 如果当前 llama-server 版本无法安全配置 CORS，补充可选的 Vite/Nginx 代理说明；只有在确认必要时才修改 vite.config.ts，并保持生产部署行为清晰。

验收标准：
- 文档中的环境变量名与 src/config.ts 完全一致；
- 命令、端口和 endpoint 不互相矛盾；
- npm run build 通过；
- git diff 中没有真实机器路径和密钥。
```

## 第 6 步：真实服务联调与回归验收

### 提示词

```text
任务：对已完成的双服务实现进行只读检查、真实接口联调（如果本机服务可用）和完整回归；不要在此步骤扩大功能范围。

请完成：
1. 先运行 npm run test -- --run、npm run build、npm run lint（如果 lint 在仓库已有问题，要区分既有问题和本次问题）。
2. 读取当前 .env（只检查变量名和值是否存在，不要在输出中打印 API key），确认 ruyi 与 llama 地址配置。
3. 使用 curl 或浏览器开发工具分别验证：
   - ruyi /health、/v1/models；
   - llama /health、/v1/models；
   - llama /v1/chat/completions 非流式请求；
   - 如配置认证，验证 Authorization 行为。
4. 在页面中验证四条路径：Buddy 单独运行、llama 单独运行、顺序对比、取消运行；检查输出文本、finish reason、usage、tokens/s、错误提示和刷新状态。
5. 重点检查 CORS preflight、超时、服务不可用、模型 alias 不匹配、空 choices、llama timings 缺失等边界情况。
6. 只修复本次改造导致的问题；不要为了联调把模型文件或密钥加入仓库。
7. 输出一份简短联调报告：服务地址（可脱敏）、接口状态、测试命令结果、页面验证结果、遗留问题。

验收标准：
- 单侧服务故障不会阻塞另一侧单独运行；
- 两侧都 ready 时对比可完成；
- 取消后没有残留 running 状态或错误覆盖；
- 所有自动化测试和构建通过。
```

## 第 7 步（可选）：增加 SSE 流式输出和首 token 指标

只有第 1～6 步稳定后才建议执行此步。它会改变 API 读取方式和测试量，不应与基础直连改造混在同一个任务中。

### 提示词

```text
任务：在现有非流式 llama-server 直连已经稳定的前提下，为 llama.cpp 增加可取消的 SSE 流式输出，并准确记录首 token 时间。Buddy-MLIR 可以暂时保持非流式。

请完成：
1. 在 llama client 中新增独立的 streamLlamaInference，不修改现有非流式函数的行为；请求使用 stream:true。
2. 使用 response.body.getReader() 按 UTF-8 增量解码，正确处理跨 chunk 的 SSE 行；解析 data: [DONE] 和 JSON delta；拼接 choices[].delta.content。
3. 在收到第一个非空 token 时记录 timeToFirstTokenMs；在流结束时记录总 latency；支持 AbortSignal 取消并释放 reader。
4. 将流式事件通过回调或 AsyncGenerator 交给 React hook，避免在 client 中直接修改 React state。
5. 保持统一 EngineResult；若服务没有 usage/timings，在流结束后使用可解释的 fallback，并明确 metricsSource。
6. 增加纯函数和流解析测试：跨 chunk、空 delta、DONE、服务端错误、取消、非 UTF-8 边界。不要依赖真实网络。
7. 在 UI 中增加明确的 stream 开关或固定只对 llama 使用流式，并在 README 中说明 Buddy/llama 指标不可完全同口径比较。

验收标准：
- 非流式回退仍可用；
- 页面能增量显示 llama 输出；
- 取消后 reader 和 AbortController 均正确清理；
- 自动化测试、构建和 lint 通过。
```

## 推荐执行节奏

最小可用版本按 1～6 步执行即可。若只需要验证 llama.cpp 直连而暂时不关心首 token，先不要做第 7 步。每一步完成后保留清晰的小 diff，出现问题时可以只回滚当前模块，而不会影响已经验证过的 ruyi-serving 适配。

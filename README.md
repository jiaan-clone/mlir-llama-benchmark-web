# Buddy-MLIR vs llama.cpp Performance Lab

这是一个面向本地推理的前端 MVP，可用同一组 Prompt 和采样参数单独请求 Buddy-MLIR 或 llama.cpp，也可并发请求两者进行对比，并排展示真实输出和 tokens/s、延迟、Token 用量等指标。

浏览器通过两条独立链路访问后端：Buddy-MLIR 仍由 `ruyi-serving` 管理；llama.cpp 由独立的 `llama-server` 提供 OpenAI 兼容接口。前端不会执行本地命令。

ruyi-serving 的模型准备和 Compute Server 配置见
[`docs/ruyi-serving-integration.md`](docs/ruyi-serving-integration.md)；llama-server 直连配置和联调见
[`docs/llama-direct-integration.md`](docs/llama-direct-integration.md)。

## 运行

```bash
npm install
cp .env.example .env
npm run dev
```

默认开发地址是 `http://localhost:5173`。访问页面前，请分别启动 ruyi-serving API（默认 `http://127.0.0.1:8000`）和 llama-server（默认 `http://127.0.0.1:8080`）。

生产构建与预览：

```bash
npm run build
npm run preview
```

## 配置

`.env` 支持：

```env
VITE_RUYI_API_BASE_URL=http://127.0.0.1:8000
VITE_RUYI_API_KEY=
VITE_RUYI_INFERENCE_TIMEOUT_MS=1800000
VITE_LLAMA_SERVER_BASE_URL=http://127.0.0.1:8080
VITE_LLAMA_SERVER_API_KEY=
VITE_LLAMA_INFERENCE_TIMEOUT_MS=1800000
VITE_DEFAULT_PROFILE_ID=deepseek-r1-1.5b
VITE_MODEL_PROFILES_JSON=[{"id":"deepseek-r1-1.5b","name":"DeepSeek R1-Distill-Qwen-1.5B","buddyModelId":"deepseek-r1-buddy","llamaModelId":"deepseek-r1-llama","llamaServerModelId":"deepseek-r1-llama"}]
```

旧的 `VITE_API_BASE_URL` 仍可作为 `VITE_RUYI_API_BASE_URL` 的 fallback。`llamaServerModelId` 是可选字段，缺省时使用 `llamaModelId`。

慢速设备可分别设置 `VITE_RUYI_INFERENCE_TIMEOUT_MS` 和 `VITE_LLAMA_INFERENCE_TIMEOUT_MS`，控制 Buddy 与 llama 普通及流式推理的前端等待时间（单位毫秒）。示例值 `1800000` 为 30 分钟；未配置或值无效时为 120000（2 分钟）。健康检查和模型列表仍为 10 秒。修改后重启 `npm run dev` 并刷新页面。后端模型的 `request_timeout_ms` 及代理超时也需足够长；流式请求还受后端空闲超时限制，前端配置不能覆盖这些限制。

每个 profile 必须包含：

- `id`：前端 profile ID
- `name`：页面显示名称
- `buddyModelId`：ruyi-serving 中指向 buddy-server 的模型 ID
- `llamaModelId`：旧配置中的 llama 模型 ID，同时作为 llama-server ID 的 fallback
- `llamaServerModelId`：可选的 llama-server `/v1/models` alias

页面分别请求两个服务的 `GET /v1/models`，单独运行只要求对应服务和模型可用，对比运行要求两侧模型都可用。DeepSeek R1 只是默认示例，后续可以在 `VITE_MODEL_PROFILES_JSON` 中增加其他模型。

## API 契约

Buddy-MLIR（ruyi-serving）使用：

- `GET /health`：检查 ruyi-serving
- `GET /v1/models`：读取 Buddy 模型
- `POST /v1/responses`：Responses 请求，seed 位于 `ruyi.backend_options`

llama-server 使用：

- `GET /health`：检查 llama-server
- `GET /v1/models`：读取 llama 模型
- `POST /v1/chat/completions`：OpenAI `messages`、`max_tokens`、`temperature`、`seed`，`stream` 由页面流式输出开关控制

单次请求使用相同的 Prompt、max tokens、temperature 和 seed，只替换协议与 model ID。“运行对比”会同时发起两侧请求，也可通过独立按钮仅运行某一个后端。页面上的“Buddy / llama 流式输出”默认关闭；开启后 Buddy 经 ruyi-serving 使用 `POST /v1/responses`、`stream:true`，llama 使用 `POST /v1/chat/completions`、`stream:true`，运行时可看到两侧的增量文本和首个非空文本 delta 的观测时间。要回退，关闭开关并**手动重新运行**；一侧出错不会中止另一侧，取消则会同时中止两侧请求，且不会自动重发推理请求。

Responses 流使用 `response.output_text.delta` 的顶层 `delta`；`response.completed`、`response.incomplete`、`response.failed` 是终态，也可能收到 `event: error`。它**没有 `[DONE]`**；终态中的 `response.output` 校准最终文本，`response.usage` 和 `response.ruyi.execution_metrics` 提供有效指标。`incomplete` 仍展示为结果，表示输出被 token 上限等原因截断。

响应中的 `usage`、ruyi 的 `execution_metrics` 或 llama-server 的 `timings` 优先作为指标来源。如果没有后端 tokens/s，仅在有真实输出 Token 数及正延迟时计算：Buddy 用后端延迟（缺失则浏览器请求 wall-clock），llama 优先用 `predicted_ms`（缺失才用浏览器 wall-clock）。浏览器观测首文本时间包括网络、排队与网关过滤时间，不等于后端 `time_to_first_token_ms`；一个 SSE delta/chunk 也不代表一个 token。指标来源标签只描述 tokens/s，混合指标可能来自不同位置；两后端的 tokens/s 不保证完全同口径。

## 验证

```bash
npm run test -- --run
npm run build
```

测试覆盖响应文本拼接、失败响应、可选字段缺失、speedup 计算和无效数值保护。

## 当前限制

- 单页、单用户、单次并发对比。
- Buddy 与 llama 由同一个页面开关控制是否使用流式输出；缺失用量显示不可用。
- 不负责模型下载、转换、编译或启动后端进程。
- tokens/s 取决于各服务是否返回原生 metrics；缺失时页面使用 wall-clock 估算并标记为“前端计算”。
- API key 会由 Vite 注入前端构建产物，仅适合受信任的本地环境；不应将生产密钥放进公开部署的前端。

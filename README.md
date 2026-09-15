# Buddy-MLIR vs llama.cpp Performance Lab

这是一个面向本地推理的前端 MVP，可用同一组 Prompt 和采样参数单独请求 Buddy-MLIR 或 llama.cpp，也可顺序请求两者进行对比，并排展示真实输出和 tokens/s、延迟、Token 用量等指标。

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
VITE_LLAMA_SERVER_BASE_URL=http://127.0.0.1:8080
VITE_LLAMA_SERVER_API_KEY=
VITE_DEFAULT_PROFILE_ID=deepseek-r1-1.5b
VITE_MODEL_PROFILES_JSON=[{"id":"deepseek-r1-1.5b","name":"DeepSeek R1-Distill-Qwen-1.5B","buddyModelId":"deepseek-r1-buddy","llamaModelId":"deepseek-r1-llama","llamaServerModelId":"deepseek-r1-llama"}]
```

旧的 `VITE_API_BASE_URL` 仍可作为 `VITE_RUYI_API_BASE_URL` 的 fallback。`llamaServerModelId` 是可选字段，缺省时使用 `llamaModelId`。

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
- `POST /v1/chat/completions`：OpenAI `messages`、`max_tokens`、`temperature`、`seed`，固定 `stream:false`

单次请求使用相同的 Prompt、max tokens、temperature 和 seed，只替换协议与 model ID。“运行对比”的两次请求严格顺序执行，也可通过独立按钮仅运行某一个后端；第一版不启用流式输出。

响应中的 `usage`、ruyi 的 `execution_metrics` 或 llama-server 的 `timings` 优先作为指标来源。如果服务没有返回 `tokens_per_second`，页面会根据输出 Token 数和 wall-clock 延迟计算，并明确标记为“前端计算”。

## 验证

```bash
npm run test -- --run
npm run build
```

测试覆盖响应文本拼接、失败响应、可选字段缺失、speedup 计算和无效数值保护。

## 当前限制

- 单页、单用户、单次顺序对比。
- 非流式请求；组件结构为后续 SSE 扩展保留了边界。
- 不负责模型下载、转换、编译或启动后端进程。
- tokens/s 取决于各服务是否返回原生 metrics；缺失时页面使用 wall-clock 估算并标记为“前端计算”。
- API key 会由 Vite 注入前端构建产物，仅适合受信任的本地环境；不应将生产密钥放进公开部署的前端。

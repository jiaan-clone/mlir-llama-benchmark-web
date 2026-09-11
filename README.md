# Buddy-MLIR vs llama.cpp Performance Lab

这是一个面向本地推理的前端 MVP，用同一组 Prompt 和采样参数顺序请求 buddy-mlir 与 llama.cpp，并并排展示真实输出和 tokens/s、延迟、Token 用量等指标。

前端只负责展示和发起请求。两个模型进程应由 `/home/lijiaan/ruyi-serving` 的 `server_process` runtime 管理，浏览器不会执行本地命令。

完整的模型准备、服务配置、启动和联调步骤见
[`docs/ruyi-serving-integration.md`](docs/ruyi-serving-integration.md)。

## 运行

```bash
npm install
cp .env.example .env
npm run dev
```

默认开发地址是 `http://localhost:5173`。在访问页面前，请先启动 ruyi-serving API（默认 `http://127.0.0.1:8000`），并在其 `models.json` 中注册一个同时包含 buddy-mlir 和 llama.cpp 的 model profile。

生产构建与预览：

```bash
npm run build
npm run preview
```

## 配置

`.env` 支持：

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_DEFAULT_PROFILE_ID=deepseek-r1-1.5b
VITE_MODEL_PROFILES_JSON=[{"id":"deepseek-r1-1.5b","name":"DeepSeek R1-Distill-Qwen-1.5B","buddyModelId":"deepseek-r1-buddy","llamaModelId":"deepseek-r1-llama"}]
VITE_RUYI_API_KEY=
```

每个 profile 必须包含：

- `id`：前端 profile ID
- `name`：页面显示名称
- `buddyModelId`：ruyi-serving 中指向 buddy-server 的模型 ID
- `llamaModelId`：ruyi-serving 中指向 llama-server 的模型 ID

页面会请求 `GET /v1/models`，只有两侧模型 ID 都存在时才允许运行。DeepSeek R1 只是默认示例，后续可以在 `VITE_MODEL_PROFILES_JSON` 中增加其他模型。

## API 契约

页面使用：

- `GET /health`：检查 API 服务
- `GET /v1/models`：读取可用模型
- `POST /v1/responses`：分别请求两个模型

单次请求使用相同的 `input`、`max_output_tokens`、`temperature` 和 seed，只替换 `model` 字段。两次请求严格顺序执行，第一版不启用流式输出。

响应中的 `usage` 和 `execution_metrics` 优先作为指标来源。如果服务没有返回 `tokens_per_second`，页面会根据输出 Token 数和 wall-clock 延迟计算，并明确标记为“前端计算”。

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
- tokens/s 取决于 ruyi-serving 是否透传后端原生 metrics；网关侧 fallback 是 wall-clock 估算。
- API key 会由 Vite 注入前端构建产物，仅适合受信任的本地环境；不应将生产密钥放进公开部署的前端。

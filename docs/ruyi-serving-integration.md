# ruyi-serving 对接指南

本文说明如何将 `mlir-llama-benchmark-web` 的 Buddy-MLIR 链路接入本机的
`/path/to/ruyi-serving`。llama.cpp 现在由独立的 llama-server 直连，见
[`llama-direct-integration.md`](llama-direct-integration.md)；前端仍可用同一个
Prompt 并发运行两侧。

## 1. 运行架构

浏览器不直接启动模型进程，完整链路如下：

```text
浏览器
  -> ruyi-serving API（FastAPI，默认 :8000）
  -> Compute Server（gRPC，默认 :9000）
  -> Buddy-MLIR 长驻模型服务

浏览器 -> llama-server（独立 HTTP 服务，默认 :8080）
```

`compute_server` 使用 `server_process` runtime 按需启动 Buddy 模型服务，并为模型
分配本机回环端口。llama-server 由单独进程管理。前端只负责调用 HTTP API、展示
文本和性能指标。

## 2. 前置条件

需要准备：

- `/path/to/ruyi-serving` 已安装 CMake、Ninja、Python 和 gRPC/Protobuf 依赖；
- `/path/to/buddy-mlir/build/bin/buddy-server`；
- `/path/to/llama.cpp/build/bin/llama-server`；
- 同一个模型的 Buddy-MLIR RAX 制品和 llama.cpp GGUF 制品；
- 两种制品尽量使用相同模型版本、上下文长度和量化精度。

当前项目以 DeepSeek R1-Distill-Qwen-1.5B 作为默认 profile。模型文件不在
前端仓库中，需要单独准备。RAX 或 GGUF 路径不存在时，服务可以启动，但首次
推理会失败。

### 2.1 构建 Buddy-MLIR 模型服务

```bash
cd /path/to/buddy-mlir
cmake --build build --target deepseek_r1_rax buddy-server
```

期望得到：

```text
/path/to/buddy-mlir/build/bin/buddy-server
/path/to/buddy-mlir/build/models/deepseek_r1/deepseek_r1.rax
```

如果使用其他 variant 或自定义构建目录，将后面的 `tool.extra_args` 路径替换
为实际生成的 `.rax` 文件。

### 2.2 准备 llama.cpp 模型

确认 llama.cpp 服务程序存在：

```bash
test -x /path/to/llama.cpp/build/bin/llama-server
```

再准备 DeepSeek R1-Distill-Qwen-1.5B 的 GGUF 文件，例如：

```text
/path/to/models/deepseek-r1/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf
```

不要把大模型文件提交到前端仓库。性能对比时应记录模型精度、量化方式、线程、
NUMA 和 GPU offload 等参数，否则结果不能归因于运行时本身。

## 3. 配置 ruyi-serving

### 3.1 初始化配置文件

```bash
cd /path/to/ruyi-serving
cp config.example.env .env
cp compute_server.json.example compute_server.json
cp models.json.example models.json
```

确认 `compute_server.json` 使用当前模型注册表：

```json
{
  "models": {
    "config_file": "models.json"
  },
  "server": {
    "address": "0.0.0.0:9000"
  }
}
```

其余超时和日志字段可以先保留示例默认值。

### 3.2 注册 Buddy 模型 ID

直连架构下，ruyi-serving 只需要注册 Buddy-MLIR 模型。建议使用：

```text
deepseek-r1-buddy
```

在 `/path/to/ruyi-serving/models.json` 中注册该模型。下面只展示关键字段；完整
结构以 ruyi-serving 的 `docs/models.schema.json` 为准。

Buddy-MLIR 条目：

```json
{
  "id": "deepseek-r1-buddy",
  "owned_by": "deepseek-ai",
  "serving": {
    "api_mode": "both",
    "prompt_style": "buddy_deepseek_r1",
    "default_max_tokens": 128,
    "max_max_tokens": 1024,
    "max_input_chars": 32768,
    "request_timeout_ms": 120000,
    "stream_idle_timeout_s": 30,
    "allow_anonymous_models": true
  },
  "capabilities": {
    "input_modalities": ["text"],
    "output_modalities": ["text"],
    "function_calling": false,
    "structured_outputs": false,
    "reasoning": false,
    "logprobs": false,
    "max_context_tokens": 32768,
    "max_output_tokens": 1024,
    "sampling_parameters": ["temperature", "seed"]
  },
  "tool": {
    "cli_path": "/path/to/buddy-mlir/build/bin/buddy-server",
    "extra_args": "--model /path/to/buddy-mlir/build/models/deepseek_r1/deepseek_r1.rax --chat-template /path/to/buddy-mlir/examples/BuddyDeepSeekR1/deepseek-r1.json",
    "runtime": "server_process",
    "prompt_delivery": "arg"
  }
}
```

> 下面的 llama.cpp 条目是旧版“两个模型都由 ruyi-serving 管理”的迁移参考，
> 直连模式不应再添加它；请使用 [`llama-direct-integration.md`](llama-direct-integration.md)
> 启动独立 llama-server。

旧版 llama.cpp 条目：

```json
{
  "id": "deepseek-r1-llama",
  "owned_by": "deepseek-ai",
  "serving": {
    "api_mode": "both",
    "prompt_style": "buddy_deepseek_r1",
    "default_max_tokens": 128,
    "max_max_tokens": 1024,
    "max_input_chars": 32768,
    "request_timeout_ms": 120000,
    "stream_idle_timeout_s": 30,
    "allow_anonymous_models": true
  },
  "capabilities": {
    "input_modalities": ["text"],
    "output_modalities": ["text"],
    "function_calling": false,
    "structured_outputs": false,
    "reasoning": false,
    "logprobs": false,
    "max_context_tokens": 32768,
    "max_output_tokens": 1024,
    "sampling_parameters": ["temperature", "seed"]
  },
  "tool": {
    "cli_path": "/path/to/llama.cpp/build/bin/llama-server",
    "extra_args": "--model /path/to/models/deepseek-r1/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf --no-webui",
    "runtime": "server_process",
    "prompt_delivery": "arg"
  }
}
```

Buddy 记录的 `prompt_style` 按模型模板配置即可。不要在 `extra_args` 中手动写
`--host` 或 `--port`，因为
`compute_server` 会自动追加 `--host 127.0.0.1 --port <动态端口>`。

> `allow_anonymous_models` 只适合本机联调。对外提供服务时应关闭它并配置 API
> Key。

### 3.3 配置 API 地址、认证和 CORS

浏览器与 API 在同一台机器时，可以使用回环地址：

```env
# /path/to/ruyi-serving/.env
GRPC_SERVER_ADDRESS=localhost:9000
API_BIND_HOST=127.0.0.1
API_BIND_PORT=8000
MODELS_CONFIG_FILE=models.json
API_KEY=
CORS_ALLOW_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

浏览器在另一台机器时，API 必须监听外部网卡，并将前端来源加入 CORS：

```env
API_BIND_HOST=0.0.0.0
API_BIND_PORT=8000
CORS_ALLOW_ORIGINS=http://10.30.175.2:5173
```

实际来源必须与浏览器地址中的协议、IP、端口完全一致。如果 Vite 自动选择了
其他端口，例如 `5175`，CORS 也必须使用该端口。只开放可信内网，生产环境
不要把 API Key 写入公开前端构建产物。

## 4. 构建并启动 ruyi-serving

在终端一启动 Compute Server：

```bash
cd /path/to/ruyi-serving
cmake --preset linux-debug
cmake --build --preset linux-debug-build \
  --target generate_python_proto compute_server
./build/bin/compute_server --config ./compute_server.json
```

在终端二启动 FastAPI：

```bash
cd /path/to/ruyi-serving
python3 -m uvicorn api_server.main:app \
  --host "${API_BIND_HOST:-127.0.0.1}" \
  --port "${API_BIND_PORT:-8000}"
```

也可以使用仓库提供的 quickstart 脚本。它会负责构建、启动、健康检查和一次
smoke request，适合本机快速验证：

```bash
cd /path/to/ruyi-serving
./ops/quickstart_local.sh
```

## 5. 使用 curl 验证服务

### 5.1 健康和就绪检查

```bash
curl --noproxy '*' -sS http://127.0.0.1:8000/health
curl --noproxy '*' -sS http://127.0.0.1:8000/ready
```

`/health` 只表示 API 可访问；`/ready` 还会检查 Compute Server。首次请求
`server_process` 模型时，模型服务可能仍在加载，等待后重试。

### 5.2 检查模型列表

```bash
curl --noproxy '*' -sS http://127.0.0.1:8000/v1/models
```

响应中至少应出现 Buddy 模型：

```text
deepseek-r1-buddy
```

如果配置了认证，需要增加：

```bash
-H "Authorization: Bearer <CLIENT_API_KEY>"
```

### 5.3 单模型 Responses 请求

```bash
curl --noproxy '*' -sS http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-r1-buddy",
    "input": [
      {
        "role": "user",
        "content": [{"type": "input_text", "text": "Say READY only."}]
      }
    ],
    "max_output_tokens": 16,
    "temperature": 0,
    "ruyi": {
      "backend_options": {"seed": 42}
    }
  }'
```

成功响应的文本位于：

```text
output[].content[].text
```

性能指标位于：

```text
ruyi.execution_metrics.latency_ms
ruyi.execution_metrics.time_to_first_token_ms
ruyi.execution_metrics.tokens_per_second
```

DeepSeek R1 可能在输出最终答案前消耗较多 reasoning token；正常检查不要把
`max_output_tokens` 设得过小。

### 5.4 Buddy Responses 流式请求

页面“Buddy 流式输出”默认关闭；开启后仅 Buddy 使用 SSE，llama 页面仍为非流式。
流式出错或取消不会自动用非流式重发。手动关闭开关并重新运行即可回退。
浏览器仍只连接 ruyi-serving，不直连 compute_server 分配的 buddy-server 端口。

```bash
curl --noproxy '*' -N -sS http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'Authorization: Bearer <CLIENT_API_KEY>' \
  -d '{
    "model": "<BUDDY_MODEL_ID>",
    "input": [{"role": "user", "content": [{"type": "input_text", "text": "Say READY only."}]}],
    "max_output_tokens": 128,
    "temperature": 0,
    "ruyi": {"backend_options": {"seed": 42}},
    "stream": true
  }'
```

未开启认证时去掉 Authorization 行。响应 Content-Type 应为 `text/event-stream`，
`event: response.output_text.delta` 的顶层 `delta` 是文本增量；
`response.completed`、`response.incomplete`（例如达到输出 token 上限）、
`response.failed` 之一是正常终止类型，故障也可能是 `event: error`。
Responses **不发送 `[DONE]`**。终态 `response.output[].content[].text` 校准最终文本，
`response.usage` 是实际用量，`response.ruyi.execution_metrics` 是后端执行指标。
截断的 `incomplete` 仍展示已有内容，不当作服务断连。

首个非空文本 delta 的浏览器观测时间包括网络传输、排队与可能的网关过滤延迟，
不等于后端 `time_to_first_token_ms`。一个 SSE chunk 或 delta 可能包含多个 token，
不能从事件数或字符数推算用量。有效后端指标优先，缺失延迟用请求 wall-clock，
缺失后端 TTFT 用浏览器观测值。缺失 token 用量不填 0，也不估算 TPS；仅有
真实输出 token 数和正延迟时才计算 TPS fallback。非流式 Buddy fallback
用请求 wall-clock；llama 非流式优先用 `predicted_ms`，无此值才用请求 wall-clock。
页面的“前端计算”标签只描述 TPS 来源，并不意味着每个指标同源；两侧 TPS
也不保证严格同口径。

## 6. 配置并启动前端

```bash
cd /path/to/mlir-llama-benchmark-web
cp .env.example .env
```

同机访问配置：

```env
VITE_RUYI_API_BASE_URL=http://127.0.0.1:8000
VITE_RUYI_API_KEY=
VITE_LLAMA_SERVER_BASE_URL=http://127.0.0.1:8080
VITE_LLAMA_SERVER_API_KEY=
VITE_DEFAULT_PROFILE_ID=deepseek-r1-1.5b
VITE_MODEL_PROFILES_JSON=[{"id":"deepseek-r1-1.5b","name":"DeepSeek R1-Distill-Qwen-1.5B","buddyModelId":"deepseek-r1-buddy","llamaModelId":"deepseek-r1-llama","llamaServerModelId":"deepseek-r1-llama"}]
```

跨机器访问时，`VITE_RUYI_API_BASE_URL` 要填写运行 ruyi-serving 那台机器的地址；`VITE_LLAMA_SERVER_BASE_URL` 填写 llama-server 地址：

```env
VITE_RUYI_API_BASE_URL=http://10.30.175.2:8000
VITE_LLAMA_SERVER_BASE_URL=http://10.30.175.2:8080
```

Vite 环境变量在启动/构建时读取，修改 `.env` 后需要重启前端：

```bash
npm install
npm run dev -- --host 0.0.0.0
```

另一台机器的浏览器访问 Vite 输出的 Network 地址，例如：

```text
http://10.30.175.2:5173
```

页面加载后按以下顺序确认：

1. 01 `RUNTIME STATUS` 可以访问；
2. ruyi `/v1/models` 中 Buddy 模型存在，llama `/v1/models` 请按直连指南检查；
3. 02 profile 显示 DeepSeek R1；
4. “运行对比”按钮可用；
5. 03 区域同时运行 Buddy-MLIR 与 llama.cpp，并独立显示两侧结果；
6. 两侧均显示输出 Token、总延迟和 Tokens/s。

## 7. 当前前端的兼容性注意事项

最新版 ruyi-serving 的 Responses 扩展字段位于 `ruyi` 命名空间：

```json
{
  "ruyi": {
    "backend_options": {"seed": 42}
  }
}
```

性能指标也位于：

```json
{
  "ruyi": {
    "execution_metrics": {
      "latency_ms": 1000,
      "time_to_first_token_ms": 100,
      "tokens_per_second": 12.5
    }
  }
}
```

接入前请确认前端 `src/api.ts` 与此结构一致：

- 请求不能把 `backend_options` 放在顶层；
- 响应解析不能只读取顶层 `execution_metrics`；
- `usage` 仍读取 `input_tokens`、`output_tokens`、`total_tokens`；
- 输出文本仍从 `output[].content[]` 中拼接 `output_text`。

如果暂时不修改前端代码，seed 可能被 ruyi-serving 拒绝，后端原生
Tokens/s 也可能无法显示；这不是模型进程本身的故障。

## 8. 修改模型后的重载

编辑 `models.json` 后，可以调用管理接口重载注册表：

```bash
curl --noproxy '*' -sS -X POST \
  http://127.0.0.1:8000/v1/admin/reload-models \
  -H "Authorization: Bearer <ADMIN_API_KEY>"
```

如果 `server_process` 的 `cli_path` 或 `extra_args` 发生变化，Compute Server
会停止旧子进程，下一次请求时按新配置重新启动。修改认证、CORS 或 API 监听
地址后，需要重启 FastAPI 进程。

## 9. 常见故障排查

### 页面显示“无法连接 ruyi-serving”

```bash
ss -ltnp | rg ':8000\\b'
curl --noproxy '*' -i http://127.0.0.1:8000/health
```

如果端口被其他程序占用，停止占用进程或修改 `API_BIND_PORT`，并同步修改
前端的 `VITE_RUYI_API_BASE_URL`。llama-server 端口变化时同步修改
`VITE_LLAMA_SERVER_BASE_URL`。

### ruyi `/v1/models` 没有 Buddy 模型

- 检查 `compute_server.json` 的 `models.config_file`；
- 检查 API `.env` 的 `MODELS_CONFIG_FILE`；
- 确认 `models.json` 是合法 JSON；
- 重载模型注册表或重启服务。

### 模型列表存在，但点击后推理失败

```bash
test -x /path/to/buddy-mlir/build/bin/buddy-server
test -x /path/to/llama.cpp/build/bin/llama-server
test -f /path/to/buddy-mlir/build/models/deepseek_r1/deepseek_r1.rax
test -f /path/to/models/deepseek-r1/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf
```

再查看 Compute Server 日志。`server_process` 子进程只在第一次推理时启动，
所以启动阶段看不到模型服务端口是正常的。

### 跨机器浏览器被 CORS 拒绝

将浏览器地址栏中的完整 origin（例如 `http://10.30.175.2:5173`）加入
`CORS_ALLOW_ORIGINS`，重启 FastAPI。不要只填写 IP，也不要写前端页面路径。

### 流式首文本很迟、缺少终态或取消后仍占用计算

- 检查浏览器 Network 中 `OPTIONS` 预检的允许 Origin、Authorization 和
  Content-Type 头。地址、协议或端口不一致都可能让浏览器拦截请求。
- 反向代理缓冲或压缩可能合并 SSE 数据；对比 `curl -N` 的增量到达时间与
  浏览器观测值，检查代理缓冲、压缩配置，再决定是否修改代理。
- 未收到终态就断开、或超过总请求超时，会显示错误而不是成功；检查 API、
  Compute Server 和模型进程日志。首次模型加载可能耗费很长时间，极小的
  DeepSeek 输出预算也可能没有可见回答，不能仅以空文本判断 SSE 故障。
- 浏览器取消会中止 fetch/reader，但 AbortError 本身不能证明后端计算已停止；
  要结合服务日志观察取消是否经 Compute Server 传播并释放当前任务。

## 10. 安全和性能基线

- API 对外监听时不要留空 `API_KEY`；
- 不要把生产 API Key 写入公开前端构建产物；
- 对比时固定 Prompt、`max_output_tokens`、temperature、seed、模型精度和硬件；
- 第一次请求包含模型加载成本，正式比较前应先预热两侧；
- “运行对比”会并发发起两侧请求，结果可能受到共享 CPU、内存和网络资源竞争影响；
- 没有后端原生 Tokens/s 时，页面的 fallback 是前端 wall-clock 估算值。

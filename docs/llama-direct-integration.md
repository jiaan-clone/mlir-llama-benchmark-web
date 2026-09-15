# llama-server 直连指南

本项目的 llama.cpp 链路不经过 ruyi-serving：浏览器直接请求独立的
`llama-server`。Buddy-MLIR 仍按 [`ruyi-serving-integration.md`](ruyi-serving-integration.md)
中的链路运行。

## 启动 llama-server

在已构建的 llama.cpp 目录中，用实际模型路径启动服务。`--alias` 必须与
前端 profile 的 `llamaServerModelId`（或其回退的 `llamaModelId`）一致：

```bash
/path/to/llama.cpp/build/bin/llama-server \
  --host 0.0.0.0 \
  --port 8080 \
  --alias deepseek-r1-llama \
  --model /path/to/models/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf \
  --no-webui
```

本地联调也可以把 `--host` 改为 `127.0.0.1`。不要将 GGUF 文件提交到本仓库。

前端 `.env` 示例：

```env
VITE_LLAMA_SERVER_BASE_URL=http://127.0.0.1:8080
VITE_LLAMA_SERVER_API_KEY=
VITE_MODEL_PROFILES_JSON=[{"id":"deepseek-r1-1.5b","name":"DeepSeek R1-Distill-Qwen-1.5B","buddyModelId":"deepseek-r1-buddy","llamaModelId":"deepseek-r1-llama","llamaServerModelId":"deepseek-r1-llama"}]
```

`llamaServerModelId` 是可选的；未设置时客户端发送 `llamaModelId`。Vite 环境变量在启动/构建时读取，修改后需要重启前端。

## curl 验证

```bash
curl --noproxy '*' -sS http://127.0.0.1:8080/health
curl --noproxy '*' -sS http://127.0.0.1:8080/v1/models
```

非流式聊天请求如下。响应文本位于 `choices[0].message.content`：

```bash
curl --noproxy '*' -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-r1-llama",
    "messages": [{"role": "user", "content": "Say READY only."}],
    "max_tokens": 16,
    "temperature": 0,
    "seed": 42,
    "stream": false
  }'
```

如果服务启用了认证，为每个请求增加：

```bash
-H "Authorization: Bearer <CLIENT_API_KEY>"
```

前端的 `VITE_LLAMA_SERVER_API_KEY` 只适合受信任的本地环境；Vite 会把它注入浏览器构建产物，不要在公开部署中放生产密钥。

## CORS、认证和反向代理

- 直接浏览器访问时，llama-server 必须允许 Vite 页面 origin（例如
  `http://localhost:5173`）。不同版本的 llama.cpp 对 CORS 参数支持不同，先以
  `llama-server --help` 和当前版本文档为准。
- 如果版本无法安全配置 CORS，推荐让 Nginx 或 Vite 开发代理与页面同源，再由代理转发到 `127.0.0.1:8080`。生产部署应在反向代理层处理 TLS、Origin 白名单、Authorization 和限流。
- Vite 开发代理示例（仅开发环境）：

  ```ts
  // vite.config.ts 的 server.proxy
  '/llama-api': {
    target: 'http://127.0.0.1:8080',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/llama-api/, ''),
  }
  ```

  使用代理时将 `VITE_LLAMA_SERVER_BASE_URL=/llama-api`；生产环境请用明确的 Nginx/网关配置，避免把开发代理误当作安全边界。

## 指标口径

非流式响应无法可靠测量首 token 时间，因此页面的“首 token”通常显示为 `—`。
llama-server 返回 `timings.predicted_per_second` 时，页面将其作为后端
Tokens/s；如果只有 `predicted_ms` 和 token 数，则计算一个前端 fallback。总延迟
优先读取 `timings.total_ms`，否则使用 `prompt_ms + predicted_ms`。两者都缺失时，
React 层使用请求 wall-clock 作为延迟；没有 completion token 时不会伪造 Tokens/s。
Buddy 的 ruyi execution metrics 与 llama 的 timings 来自不同服务，适合观察趋势，
不应视为严格同口径基准。

## 常见故障

- **无法连接 llama-server**：检查 `ss -ltnp | rg ':8080\\b'`、`/health` 响应和
  `VITE_LLAMA_SERVER_BASE_URL`，确认修改 `.env` 后已重启 Vite。
- **模型 alias 不匹配**：比较 `/v1/models` 返回的 `id` 与
  `llamaServerModelId`；没有 alias 时将 profile 字段改为实际 `id`。
- **浏览器 CORS/preflight 失败**：确认允许完整 origin（协议、主机和端口），或改用同源 Nginx/Vite 代理；Authorization 会触发预检请求。
- **模型列表成功但推理失败**：先用上面的 curl 请求复现，再检查 GGUF 路径、上下文长度、显存和 llama-server 日志。
- **缺少 timings/usage**：这是服务版本或配置能力差异，页面会显示可用字段并将无法计算的指标显示为 `—`。
- **请求超时或取消后仍显示运行中**：刷新页面状态并确认 llama-server 仍在监听；前端使用 AbortController 清理当前请求，不会重启模型进程。

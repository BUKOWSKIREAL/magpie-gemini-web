# Gemini Native Task 桥接与 Magpie 扩展

本目录包含针对 macOS 原生 Gemini App 任务模式（Task Mode / Argon）的本地常驻守护进程与 Magpie 扩展插件。此实现为 Alpha 预览版本，提供文本对话及串行 OpenAI Function Calling 工具调用能力。

## 前置要求与环境限制

1. **操作系统**：仅支持 macOS（arm64），需已安装 `/Applications/Gemini.app`（版本 `1.128.14.1166`，SHA-256 `8cd89234b23182234e8e211e1449ae44e0a831b2185e98f4d1371a83c66f8964`）。
2. **已登录账户**：需在 Gemini.app 中已登录可用账户，桥接器通过只读 Keychain API 读取原生凭据并执行 OAuth 续期。
3. **App 必须退出**：在运行原生 Task 任务时，本机运行的 Gemini.app 进程必须处于退出状态（`pgrep -x Gemini` 必须为空），避免长连接与设备状态冲突。
4. **抓取模板**：首次配置需要有效的会话头与消息模板（`task-headers.json`、`tool-headers.json`、`task-template.bin`、`turn-template.bin`）。`x-server-token` 与设备凭据暂未实现自动续期，需由已抓取模板手工提供。

## 架构与行为特性

- **模型标识**：网关模型 ID 为 `gemini-web/gemini-task-argon`（本地服务模型 ID 为 `gemini-task-argon`）。
- **工具调用**：支持 OpenAI Function Calling 格式的串行工具调用（单轮至多 1 个工具调用），由客户端执行并回传结果。工具声明映射至 `agent_bridge` 服务。单个 Task 上限 32 次工具调用（非整个会话全局上限）。
- **并发与超时**：全局同一时刻仅允许 1 个活跃 Task。任务全局超时为 240 秒，单次工具等待超时为 50 秒。无断线自动重连或重放机制。
- **会话与持久化**：调用 Magpie 网关时必须提供稳定的 `X-Session-ID`，由插件的 `chat.headers` 将它转换为本机服务使用的 `X-Gemini-Session`。直接访问本机服务时使用 `X-Gemini-Session`。仅在网关传 `X-Magpie-Session` 不足以保证重试和续轮使用同一 ID。会话状态持久化于私有目录（`~/.local/share/gemini-native-task/sessions/*.json`，权限 `0600`）。
- **容量与历史限制**：单个会话最多缓存 256 次请求记录，本地最多存储 128 个会话。不支持透明的历史压缩、修改或分支分叉（修改历史需开启新会话）。
- **中断恢复与取消**：守护进程重启时，未完成的会话将标记为 `interrupted`，不会继续重放或悬挂。本地取消仅中止本地工作线程与流，服务端不保证原生任务取消。
- **协议与参数说明**：
  - 允许传入 `system` / `developer` 角色消息，通过精确的前置提示词进行转译兼容，但服务端无原生系统角色通道。
  - `max_tokens` / `max_completion_tokens` 仅作为兼容性提示词建议注入，服务端无硬性切断。
  - 不提供 Token 用量统计（Token Usage）。
  - 流式响应（SSE）按阶段（工具调用 / 最终答案）缓冲输出，非逐字 Token 流。
  - 不支持采样参数（temperature / top_p）或结构化输出（JSON Schema response format）。
  - 原生对话记录保留在 Google 服务端。

## 验证状态

2026-10-15：已执行通过 41 项 Python 测试和 12 项 Node 测试；真实 Magpie `0.1.1244` 的隔离环境完成了插件安装、本地连接、模型发现及 8 个 HTTP 请求的工具往返测试。该网关测试使用模拟原生上游，包含两次串行工具、最终答案重试、错误会话/调用 ID 拒绝、旧工具阶段拒绝和下一轮用户消息。

2026-10-15：通过 `magpie-gemini-web` 0.4.0 的 Task 登录方式（直接加载插件，未经 Magpie 网关）完成了一次真实 Argon 工具往返：模型返回 `Read` 工具调用（19.2 秒），回传工具结果后得到正确的最终答案（13.7 秒）。此前真实 Task 请求曾被 Google 以 `Remy quota exhausted`（gRPC 8）拒绝，服务将该错误映射为 `native_quota_exhausted`，不会自动重发 Task。

已知问题：客户端收到工具调用后若不回传结果（例如 agent 中途被打断），该 Task 会一直占用唯一的名额，直到工具等待和任务超时到期（最长约 4 分钟），期间其他请求返回 409 `concurrency_limit`。另外曾出现过一次首个健康检查超时（2 秒），未能复现。

## Magpie 插件安装与登录

Task 已并入 `magpie-gemini-web` 插件，不需要单独安装。先完成下面的本地服务 Setup，再登录并选择「macOS 原生 Task（实验性）」：

```bash
magpie plugin login gemini-web
```

登录后模型为 `gemini-web/gemini-task-argon`。没有完成 Setup 时，这个选项会报错并给出 setup 命令。

## 本地桥接守护进程 CLI

默认数据目录为 `~/.local/share/gemini-native-task`，默认监听端口为 `8084`。

### 1. 引导配置（Setup）

```bash
node native-task/scripts/bridge.mjs setup \
  --data-dir ~/.local/share/gemini-native-task \
  --auth-file /path/to/encrypted_auth_file \
  --task-headers /path/to/task-headers.json \
  --tool-headers /path/to/tool-headers.json \
  --task-template /path/to/task-template.bin \
  --turn-template /path/to/turn-template.bin
```

### 2. 启动服务（Start）

```bash
node native-task/scripts/bridge.mjs start --data-dir ~/.local/share/gemini-native-task
```

### 3. 查看状态（Status）

```bash
node native-task/scripts/bridge.mjs status --data-dir ~/.local/share/gemini-native-task
```

### 4. 停止服务（Stop）

```bash
node native-task/scripts/bridge.mjs stop --data-dir ~/.local/share/gemini-native-task
```

## 离线开发与回归测试命令

在仓库根目录下执行（Python 3.10+、Node 22+）：

```bash
python3 -m venv native-task/.venv
native-task/.venv/bin/pip install -e ./native-task
native-task/.venv/bin/python -m unittest discover -s native-task/tests -v
node --test native-task/test/*.test.mjs
```

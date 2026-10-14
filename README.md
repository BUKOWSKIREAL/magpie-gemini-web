# magpie-gemini-web

Gemini Web provider plugin for [Magpie](https://usemagpie.ai/)（遵循 OpenCode v1 插件接口规范），基于 [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) (v4.22.0) 独立原生后端构建。

---

## 1. 为什么选择此方案（选型理由与架构说明）

将 Gemini 网页版接入 AI Agent 工具链通常面临复杂的网页抓包协议、Cookie 会话维持及接口兼容问题。本方案采用独立原生后端 + Magpie 接入插件的解耦架构：

1. **架构解耦与职责划分**：
   - **Magpie 插件层**（本目录）：纯 JavaScript (ESM)，无第三方依赖。负责实现 Magpie / OpenCode v1 规范的认证生命周期 (`auth`)、动态模型目录发现 (`models`)、请求流式转发与输入过滤 (`forward`)。
   - **原生后端层**（`gemini-web2api-go`）：由上游独立 Go 进程运行，负责维护 Google 账户 Cookie 会话池与 OpenAI 兼容格式转换。
   - **凭证安全隔离**：插件与 Magpie **绝不直接接触 Google 账号 Cookie 或用户浏览器会话**，仅通过本地生成的随机 `apiKey` 与本地后端通信。
2. **本地回环安全保护**：
   - 上游原生后端默认配置监听 `0.0.0.0`。本插件安装助手生成的默认配置将监听地址**严格锁定为本地回环 `127.0.0.1:8083`**，避免服务与管理端端口暴露至局域网或公网。
   - 转发层在请求到达后端前剥离调用方所有的 `Cookie`、`Authorization`、`x-api-key`、`anthropic-*` 等敏感头部。
3. **并发抑制**：
   - 插件声明了 `maxConcurrency: 1`。该配置旨在降低短时间内并发请求频率，但**不能保证账号绝不被 Google 风控或封禁**；用户应知悉使用网页逆向服务的潜在风险。
4. **开源协议**：
   - 上游项目与本插件均基于宽松的 MIT 许可证。

---

## 2. 运行环境要求

- **Node.js**：版本 `>= 22`（用于执行安装与管理脚本 `npm run backend:*` 及单元测试）。
- **Magpie / Bun**：Magpie 客户端内置管理其插件运行环境（基于 Bun 执行插件），无需全局安装 Bun。
- **操作系统支持**：
  - 本项目的自动安装与启动助手（`npm run backend:install` / `backend:start`）**仅针对 macOS (arm64 Apple Silicon)** 进行了二进制锁定与 SHA-256 完整性强校验。
  - **其他操作系统（Linux / Windows / Intel Mac）**：请**不要**将其他平台二进制放入助手目录。请直接参考上游 [gemini-web2api-go 文档](https://github.com/zexadev/gemini-web2api-go) 手动运行上游服务，并在 Magpie 登录插件时将 `baseURL` 指向上游监听地址即可。

---

## 3. 快速上手

插件与后端需要分别安装。Magpie 安装插件时不会执行安装脚本，也不会自动启动 Go 后端。先获取管理脚本：
```bash
git clone https://github.com/BUKOWSKIREAL/magpie-gemini-web.git
cd magpie-gemini-web
```
官方后端自 v4.22.0 起已包含 `gemini-4-argon` / `gemini-4-argon-thinking`，但不核对上游实际返回的模型：无权限、Cookie 失效或配额耗尽时会被静默降级成 3.5 Flash-Lite。需要身份校验与延迟优化时，请直接按第 5 节构建补丁版后端，再完成 Cookie 配置和插件登录；不要先启动官方后端占用同一端口。

### 步骤 1：安装后端二进制（macOS arm64）

运行内置下载安装脚本（锁定版本 v4.22.0，SHA-256 为 `c69ca75cf43017cf2a62dbf5c12b07f6bde66f403f714c32209b1ad350ed24c9`）：

```bash
npm run backend:install
```

该命令将在本地数据目录（默认 `~/.local/share/magpie-gemini-web`，或通过环境变量 `GEMINI_WEB_DATA_DIR` 自定义）完成：
1. 校验哈希并原子化安装二进制至 `bin/gemini-web2api-go`（权限 `0700`）。
2. 初始化 `config.json`（将 host 显式绑定为 `127.0.0.1`，权限 `0600`）。
3. 生成随机的 `apiKey` 和 `adminToken` 并写入 `secrets.json`（权限 `0600`）。

`secrets.json` 位于上述数据目录下（默认 `~/.local/share/magpie-gemini-web/secrets.json`），包含两个本地随机凭证，均与 Google 账号无关：

| 字段 | 用途 |
| :--- | :--- |
| `apiKey` | 插件访问后端的密钥（`gw_` 开头），在 Magpie 登录插件时填写 |
| `adminToken` | 后端管理面板 `http://127.0.0.1:8083/admin` 的登录口令 |

只要不删除 `secrets.json`，重复执行 `backend:install` 不会重新生成这两个值；若重新生成了 `apiKey`，需要在 Magpie 中重新登录插件。

### 步骤 2：启动后端服务

```bash
npm run backend:start
```

- 该服务在前台运行，会将日志输出至终端。
- 可在另一终端执行以下命令确认后端已监听并响应：
  ```bash
  npm run backend:status
  ```

> 后端成功启动并列出基础模型目录，只代表本地服务通路正常，不代表全部能力可用。2026-10-14 已通过真实 Magpie 网关验证匿名 Flash Lite 普通对话；工具调用在非流式、流式和直连后端对照中均未成功，`tool_choice` 未得到满足。上游未返回缓存 token 统计，Magpie 显示的 0 不代表 Google 的实际缓存命中情况。登录态模型需要有效 Cookie。后续 Argon 补丁已验证真实 Magpie 普通对话、SSE 和首轮工具调用；工具结果回传含正确值但未严格遵循仅回显要求，图片和 Argon 缓存未验证。本地验收记录不随公开仓库或 npm 包分发。

### 步骤 3：在后端管理后台配置 Google Cookie

在本地浏览器中打开：
```
http://127.0.0.1:8083/admin
```
- 输入 `secrets.json` 中的 `adminToken` 登录管理面板。可用以下命令把它复制到剪贴板（macOS，不在终端显示）：
  ```bash
  node -p "require(require('path').join(process.env.GEMINI_WEB_DATA_DIR || require('os').homedir() + '/.local/share/magpie-gemini-web', 'secrets.json')).adminToken" | tr -d '\n' | pbcopy
  ```
- 在 Cookie 管理页面导入 Gemini 网页请求的完整 Cookie header；上游文档列出的关键项包括 `SID`、`HSID`、`SSID`、`APISID`、`SAPISID`、`__Secure-1PSID`、`__Secure-1PSIDTS`。仅有两个 `__Secure-*` 值未必足够。
- **注意**：Cookie 仅保存在后端的本地 SQLite 数据库中，插件绝不存储或转发 Cookie。

### 步骤 4：在 Magpie 中加载插件与登录

1. **添加插件**（npm 安装）：
   ```bash
   magpie plugin add magpie-gemini-web
   ```
   > 尚未发布到 npm 或从源码调试时可用 `magpie plugin add github:BUKOWSKIREAL/magpie-gemini-web` 或 `magpie plugin add /absolute/path/to/magpie-gemini-web`。

2. **登录提供商**：
   ```bash
   magpie plugin login gemini-web
   ```
   - **Backend OpenAI base URL**：留空使用默认的 `http://127.0.0.1:8083/v1`，或填入其他自定义本地/代理地址。
   - **Gemini Web backend API key**：填入 `secrets.json` 中的 `apiKey`（不是 Google Cookie）。可先用以下命令把它复制到剪贴板（macOS，不在终端显示），登录时直接粘贴：
     ```bash
     node -p "require(require('path').join(process.env.GEMINI_WEB_DATA_DIR || require('os').homedir() + '/.local/share/magpie-gemini-web', 'secrets.json')).apiKey" | tr -d '\n' | pbcopy
     ```
     其他系统去掉末尾的 `| tr -d '\n' | pbcopy` 即可直接输出。

   > 重新登录（例如更换 API key 或 base URL）后，正在运行的 Magpie 不会重新读取 provider 地址，需要执行 `magpie plugin off magpie-gemini-web && magpie plugin on magpie-gemini-web` 或重启 Magpie App 才会生效。
   >
   > 0.1.0 登录时若留空 base URL，会把空字符串存进登录信息；0.1.1 起改为存入补全后的默认地址。若遇到网关返回 502「Gemini Web has no endpoint configured」（[#3](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/3)），升级后重新登录一次，或登录时显式填写 `http://127.0.0.1:8083/v1`。

3. **配置插件选项（开启工具或图片支持）**：
   插件默认关闭工具调用与图片输入以确保安全和兼容性。若 Coding Agent（如 Claude Code / OpenCode / Cursor）需要使用工具调用，**必须显式开启 `allowTools`**，否则发送工具请求时将被插件直接返回 400 拦截：

   ```bash
   # 显式开启工具调用与图片输入
   magpie plugin options magpie-gemini-web '{"allowTools":true,"allowImages":true}'

   # 仅保持默认保守配置（关闭工具与图片）
   magpie plugin options magpie-gemini-web '{"allowTools":false,"allowImages":false}'
   ```

---

## 4. 插件选项说明 (Plugin Options)

所有数值均为客户端本地保护预算，非上游实测上限：

| 选项名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `baseURL` | string | `http://127.0.0.1:8083/v1` | 后端 OpenAI 兼容 Base URL（必须以 `/v1` 结尾，仅允许本地 loopback HTTP 或远程 HTTPS） |
| `allowTools` | boolean | `false` | 是否开启实验性工具调用。**默认为 false**，Coding Agent 若使用工具需设为 true |
| `allowImages` | boolean | `false` | 是否允许图片输入。**默认为 false** |
| `contextLimit` | integer | `32768` | 客户端声明的上下文上限预算 |
| `outputLimit` | integer | `8192` | 客户端声明的最大输出 Token 预算（需 $\le$ `contextLimit`） |
| `requestTimeoutMs`| integer | `240000` | 转发单次请求的超时时间（毫秒，默认 4 分钟） |
| `modelTimeoutMs` | integer | `10000` | 获取模型列表的超时时间（毫秒，默认 10 秒） |

### 思考档位（effort）

后端没有 effort 参数，扩展思考是单独的 `-thinking` 模型。插件把有 `-thinking` 版的模型声明为 `low` / `high` 两档，可以在 Magpie 里直接切换：

| 档位 | 实际调用 | 说明 |
| :--- | :--- | :--- |
| `low`（或不指定） | `gemini-x` | 网页端默认档：Argon 为「低」档，Flash 不输出思考链，3.1 Pro 仍会少量思考 |
| `high` | `gemini-x-thinking` | 网页端扩展思考（上游显示为 High），带 `reasoning_content` |

- 插件读取请求里的 `reasoning_effort`：`none` / `minimal` / `low` 走普通版，其他值（如 `medium`、`xhigh`）走 `-thinking` 版。经 Magpie 调用时，Magpie 会先把 Responses API 的 `reasoning.effort`、Anthropic Messages 的 `thinking.budget_tokens` 换算成最接近的已声明档位；Anthropic 的 `output_config.effort` 不会被转发。
- 直接选 `-thinking` 模型照常可用，档位设置对它不生效。
- 网页端 Argon 的「中」档上游尚未支持（见 [#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)）。
- 升级插件后，执行 `magpie provider models gemini-web` 重新拉取模型列表，档位才会出现。

---

## 5. 本地开发与实验性 Argon 支持 (Local Development & Argon Support)

官方后端自 v4.22.0 起已支持 Gemini 4 Argon。本项目的补丁版在其基础上增加 Argon 身份校验与延迟优化，适合拥有 Argon 访问权限（付费 / Ultra）的账号：

### 5.1 架构与协议保护机制
- **模型标识**（模型定义来自上游 v4.22.0）：均为 HexID `95a4c0abcba24364`、Mode 8。

  | 模型 | 网页思考档位 | 上游自报模型名 |
  | :--- | :--- | :--- |
  | `gemini-4-argon` | 低 | `4 Argon` |
  | `gemini-4-argon-thinking` | 高（带 `reasoning_content`） | `4 Argon High` |

  网页端的「中」档上游尚未支持（见 [#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)）。
- **账号权限要求**：必须在后端管理面板配置拥有 Argon 访问权限的 Google 登录 Cookie；无 Cookie 时后端自动隐藏这两个模型。
- **结构化元数据校验**：由于 Google Web 对无权限、Cookie 失效或配额耗尽的请求会静默降级，后端在底层响应解析层（`argon.go`）对 Argon 请求实行严格的结构化元数据身份校验（解析 `wrb.fr` payload 中的模型 hex 与显示名，而非依赖模型自述文本），并按请求的思考档位只接受对应的显示名（普通档 `4 Argon`、扩展思考 `4 Argon High`），档位被静默替换同样视为不符。流式请求逐帧校验：确认 Argon 身份之前的帧先暂存、不发给客户端，确认后放行并继续增量转发（实测身份与首段正文同帧到达）。身份缺失或首次出现即不符时请求报错，不发送任何未验证内容；若放行之后上游又报告了其他模型，后端立即停止读取并发送流错误，但已发出的内容无法撤回。非流式请求仍完整读取后再校验。
- **协议验证状态**：`4.22.0-argon.1` 已通过真实 Magpie 网关验证两档的普通对话和 SSE：`gemini-4-argon` 后端记录实际模型 `4 Argon`，`gemini-4-argon-thinking` 记录 `4 Argon High` 并返回 `reasoning_content`。工具调用沿用 `4.21.0-argon.2` 的结论：首轮工具调用名称与参数正确，第二轮含正确测试值但附带额外说明，不代表工具兼容性已完全解决。本地验收记录不随公开仓库或 npm 包分发。
- **延迟优化**（自 `4.21.0-argon.2` 起；2026-10-14 直连后端实测，单次样本、上游波动大，仅供参考）：
  - XSRF token 按账号身份缓存，不再因每次响应刷新 SIDCC 而失效，登录态请求的前置开销由约 0.9–1.3 秒降至约 10 毫秒；Cookie 轮转后在后台重取 token。
  - Argon 流式首字约 5.4 秒（同次总耗时 9.8 秒），不再等待整段生成结束。
  - 工具调用块闭合且函数名有效时即结束读取上游并返回 `tool_calls`，Argon 首轮工具调用约 6.1 秒。
  - 超过 `max_prompt_bytes` 的请求转附件时，工具定义（紧凑 JSON）与末尾格式提醒保留在正文，附件只含对话历史；158KB 带工具请求实测可正确发起工具调用并回传结果。
  - 客户端断开或超时后，后端中止上游读取、上传与重试等待，并在请求记录中记为 499。

### 5.2 本地构建与安装步骤 (macOS arm64)

需要 upstream `go.mod` 声明的 Go 版本（Go 1.26+）与 Git。从插件根目录执行：
```bash
git clone https://github.com/zexadev/gemini-web2api-go.git backend-source
git -C backend-source checkout a65b1d1a5ac614c1b455857334b4f1c73ab8fcfb
git -C backend-source apply ../patches/argon.patch
```

源码基于 upstream tag `v4.22.0`（锁定 commit `a65b1d1a5ac614c1b455857334b4f1c73ab8fcfb`）。

> **从 `4.21.0-argon.*` 升级**：旧补丁新增的文件会与新补丁冲突，请删除 `backend-source/` 后按上面三行重新获取源码，再从下方第 1 步开始。

1. **构建 Argon 增强版后端**：
   ```bash
   npm run backend:build:argon
   ```
   该命令将在 `backend-source/` 目录执行 Go 编译，并在 `backend-build/` 生成校验清单 `manifest.json` 与二进制（版本 `4.22.0-argon.1`）。

2. **安装到本地数据目录**：
   ```bash
   npm run backend:install:argon
   ```
   安全地将构建好的 Argon 二进制安装到 `~/.local/share/magpie-gemini-web/bin/`，并同步更新编译清单，保留已有配置与密钥。

3. **启动 Argon 后端**：
   ```bash
   npm run backend:start:argon
   ```

> **版本切换提示**：如果重新执行官方标准的 `npm run backend:install`，将自动下载官方原版二进制并覆盖当前版本：Argon 模型仍可用，但不再有身份校验与延迟优化；重新执行 `npm run backend:install:argon` 即可切回 Argon 版本。

---

## 6. 局限性与风险提示

1. **实验性工具调用（Prompt Emulation）**：
   - Gemini 网页版无原生 OpenAI 格式 Function Calling 协议，上游通过系统提示词模拟实现。
   - 工具调用块需要完整解析后才以 `tool_calls` 返回（块外正文仍实时流式输出），准确度受模型指令遵循能力影响；实测 Flash 系列经常拒绝调用模拟工具。
   - 默认配置下（`allowTools: false`），若请求包含 `tools` 或 `functions`，插件会直接拒绝并返回 400 提示，绝不静默剥离工具参数。
2. **媒体输入类型限制**：
   - 即使开启 `allowImages: true`，插件也仅允许 `text` 与包含有效 URL 的 `image_url`，其他媒体类型（如 `input_audio` 等）将被严格拒绝。
3. **计费与配额说明**：
   - 动态获取的模型目录中 `cost` 统一声明为 `0`，表示本插件不向客户端计收商业 API 费用，**不代表 Google 网页端的实际使用限额或剩余配额**。Token 计数由后端估算。
4. **模型范围过滤**：
   - 插件仅暴露以 `gemini-` 开头且非多媒体专用模型（自动过滤 `image`、`video`、`music`、`canvas`、`research` 等变体）。

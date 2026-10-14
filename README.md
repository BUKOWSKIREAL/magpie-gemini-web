# magpie-gemini-web

Gemini Web provider plugin for [Magpie](https://usemagpie.ai/)（遵循 OpenCode v1 插件接口规范），基于 [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) (v4.22.0) 独立原生后端构建。

---

## 1. 快速上手（推荐：一键配置）

1. 在 Magpie 插件市场搜索并安装 **magpie-gemini-web**。
2. 在 Magpie 里登录 Gemini Web 提供商，选择 **「一键配置本地 Gemini Web（推荐）」**（命令行为 `magpie plugin login gemini-web`）。插件会：
   - 下载官方 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) v4.22.0 后端，并按发布页的 SHA-256 校验，校验不通过就不安装；
   - 生成本地随机密钥，在后台启动后端（只监听 `127.0.0.1:8083`）；
   - 打开 <https://gemini.google.com/app>，提示你复制 Cookie：
     1. 确认网页已登录要使用的 Google 账号；
     2. 按 F12（macOS 按 ⌥⌘I）打开开发者工具，切到 **Network（网络）**，刷新页面；
     3. 点任意一个 `gemini.google.com` 的请求 → **Headers（标头）** → **Request Headers（请求标头）**；
     4. 复制 `cookie` 那一行的值，粘贴回 Magpie。
3. 插件把 Cookie 导入本地后端并检测能否登录 Gemini；检测通过即完成登录，检测失败会删掉这条账号并提示原因（例如缺少哪些 Cookie、账号未登录）。全程不需要手动填写 API key。

之后每次 Magpie 启动，插件发现本地后端没在运行就会自动把它拉起来；请求时发现后端掉线也会先重启再重试一次。后端日志在数据目录下的 `backend.log`。

> 要再加一个 Google 账号，重新走一遍一键配置即可，新账号会加入后端的账号池。
>
> Cookie 只发给本机的后端，保存在它的本地 SQLite 数据库里；Magpie 保存的是后端的本地 API key，而不是 Cookie。

需要工具调用或图片输入时再开启插件选项（默认关闭，见第 4 节）：
```bash
magpie plugin options magpie-gemini-web '{"allowTools":true,"allowImages":true}'
```

**支持的平台**：一键配置为以下平台锁定了官方二进制及其 SHA-256：macOS（Apple Silicon / Intel）、Linux（x64 / arm64）、Windows（x64 / arm64）。其他平台请用第 3 节的「连接已有后端」。

---

## 2. 架构与安全说明

1. **架构解耦**：
   - **Magpie 插件层**（本仓库）：纯 JavaScript (ESM)，无第三方依赖。负责认证与一键配置、动态模型目录 (`models`)、请求转发与输入过滤 (`forward`)，以及管理本地后端进程。
   - **原生后端层**（`gemini-web2api-go`）：上游独立 Go 进程，维护 Google 账号 Cookie 池并提供 OpenAI 兼容接口。
2. **凭证隔离**：一键配置时插件只把你粘贴的 Cookie 交给本机后端的管理接口，自身不保存、不转发到其他地方；之后插件与 Magpie 仅凭本地随机 `apiKey` 访问后端。
3. **本地回环**：上游默认监听 `0.0.0.0`；本插件生成的配置**锁定为 `127.0.0.1:8083`**，启动前还会再次校验 host 与二进制哈希。若 8083 已被别的服务占用，一键配置会报错而不会覆盖，可修改数据目录下 `config.json` 的 `port`。
4. **请求过滤**：转发前剥离调用方的 `Cookie`、`Authorization`、`x-api-key`、`anthropic-*` 等头部。
5. **并发抑制**：插件声明 `maxConcurrency: 1`，降低请求频率，但**不能保证账号不被 Google 风控或封禁**；请知悉使用网页逆向服务的风险。
6. **开源协议**：上游项目与本插件均为 MIT 许可证。

**数据目录**：默认 `~/.local/share/magpie-gemini-web`（可用环境变量 `GEMINI_WEB_DATA_DIR` 自定义），包含：

| 文件 | 内容 |
| :--- | :--- |
| `bin/gemini-web2api-go` | 后端二进制（权限 `0700`） |
| `config.json` | 后端配置，host 固定 `127.0.0.1`（权限 `0600`） |
| `secrets.json` | 本地随机生成的 `apiKey`（`gw_` 开头，插件访问后端用）和 `adminToken`（管理面板 `http://127.0.0.1:8083/admin` 的口令），均与 Google 账号无关（权限 `0600`） |
| `gemini.db` | 后端的账号与请求记录 |
| `backend.log` / `backend.pid` | 插件在后台启动的后端的日志与进程号 |

只要不删除 `secrets.json`，重新配置不会更换这两个值。要查看或管理已导入的账号，可打开管理面板，用 `adminToken` 登录；把它复制到剪贴板（macOS，不在终端显示）：
```bash
node -p "require(require('path').join(process.env.GEMINI_WEB_DATA_DIR || require('os').homedir() + '/.local/share/magpie-gemini-web', 'secrets.json')).adminToken" | tr -d '\n' | pbcopy
```

---

## 3. 连接已有后端（自定义地址 + API key）

已经自己运行了 gemini-web2api-go（其他机器、反向代理或自定义端口）时，登录时选 **「连接已有后端（自定义地址 + API key）」**：

- **Backend OpenAI base URL**：留空使用默认的 `http://127.0.0.1:8083/v1`，或填入你的地址（必须以 `/v1` 结尾；本地只允许 loopback HTTP，远程须 HTTPS）。
- **API key**：后端的 `API_KEY`（不是 Google Cookie）。

这种方式下插件不会安装或启动任何后端，Cookie 也需要你自己在后端管理面板导入（关键项包括 `SID`、`HSID`、`SSID`、`APISID`、`SAPISID`、`__Secure-1PSID`、`__Secure-1PSIDTS`，仅有两个 `__Secure-*` 值未必足够）。

> 重新登录（例如更换 API key 或 base URL）后，正在运行的 Magpie 不会重新读取 provider 地址，需要执行 `magpie plugin off magpie-gemini-web && magpie plugin on magpie-gemini-web` 或重启 Magpie App 才会生效。
>
> 0.1.0 登录时若留空 base URL，会把空字符串存进登录信息；0.1.1 起改为存入补全后的默认地址。若遇到网关返回 502「Gemini Web has no endpoint configured」（[#3](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/3)），升级后重新登录一次，或登录时显式填写 `http://127.0.0.1:8083/v1`。

### 命令行管理脚本（开发者）

从源码仓库也可以手动管理同一个数据目录里的后端（需要 Node.js >= 22）：
```bash
git clone https://github.com/BUKOWSKIREAL/magpie-gemini-web.git
cd magpie-gemini-web
npm run backend:install   # 下载并校验 v4.22.0 二进制，创建 config.json / secrets.json
npm run backend:start     # 前台运行后端
npm run backend:status    # 检查后端是否响应
```
用这些脚本装好的后端，一键配置会直接复用（同一套密钥），不会重复下载。

> 后端成功启动并列出基础模型目录，只代表本地服务通路正常，不代表全部能力可用。2026-10-14 已通过真实 Magpie 网关验证匿名 Flash Lite 普通对话；工具调用在非流式、流式和直连后端对照中均未成功，`tool_choice` 未得到满足。上游未返回缓存 token 统计，Magpie 显示的 0 不代表 Google 的实际缓存命中情况。登录态模型需要有效 Cookie。后续 Argon 补丁已验证真实 Magpie 普通对话、SSE 和首轮工具调用；工具结果回传含正确值但未严格遵循仅回显要求，图片和 Argon 缓存未验证。本地验收记录不随公开仓库或 npm 包分发。

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

   装好后也可以不手动启动：插件认可已安装 Argon 版的哈希，Magpie 启动时会像官方版一样在后台拉起它。若插件已在后台运行旧版后端，先结束它（`kill $(cat ~/.local/share/magpie-gemini-web/backend.pid)`）再启动，否则端口会被占用。

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

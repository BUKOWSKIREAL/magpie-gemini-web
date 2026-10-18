# magpie-gemini-web

中文 | [English](README.en.md)

让 [Magpie](https://usemagpie.ai/) 通过你的 Google 账号使用 **Google AI Studio** 与 **Gemini 网页版**。插件在本机自动运行 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) 与 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)，将网页端能力转为 OpenAI 兼容接口。

> **2026-10-16 更新**：正价支付的 Google AI Pro 现可直接在 Antigravity 中使用 `gemini-4-argon`，同理也可直接用 Magpie 反代。

## 怎么选？

插件提供两个互相独立的 Provider，可按使用场景选择（也可同时配置）：

| 对比项 | Google AI Studio (`ai-studio`) | Gemini Web (`gemini-web`) |
| :--- | :--- | :--- |
| **适用场景** | **推荐 Coding Agent 使用** | 日常对话、使用网页版专属模型与额度 |
| **工具调用** | **原生 Function Calling**，稳定可靠 | 提示词模拟（实验性，Flash 系列常不调工具） |
| **思考档位** | `minimal` / `low` / `medium` / `high` 四档（`minimal` 最快最省） | `low`（普通）/ `high`（`-thinking` 扩展思考）两档 |
| **登录方式** | 弹出独立浏览器窗口直接登录 Google | 用无痕窗口登录并复制 `cookie` |
| **额度卡片** | 显示冷却中的模型与恢复时间 | 同步网页版 **5 小时** 与 **每周** 用量及重置时间 |
| **本地后端** | AIStudio2API (`v0.2.12`) | gemini-web2api-go (`4.22.0-magpie.1` 优化版) |

---

## 快速开始

在 Magpie 插件市场安装 **magpie-gemini-web** 后，按需登录以下任一（或两个）Provider。插件会自动下载对应后端、校验 SHA-256 并在后台自启，无需安装 Go 或其它依赖。

### 方式一：Google AI Studio (`ai-studio`)

1. 在 Magpie 中登录 **Google AI Studio**，选择 **「用 Google 账号登录（推荐）」**。
2. 在弹出的独立登录窗口中登录 Google 账号（不影响日常浏览器），完成后直接关闭窗口。
   > 首次使用会自动下载登录浏览器 Camoufox（约 300 MB），弹窗可能需要等几分钟才出现；请在 15 分钟内完成登录。
3. **后续管理**：再次点击「用 Google 账号登录」，可选择**添加新账号**、为本机已有账号建卡，或为过期账号**重新登录**。

### 方式二：Gemini Web (`gemini-web`)

1. 在 Magpie 中登录 **Gemini Web**，选择 **「一键配置本地 Gemini Web（推荐）」**。
2. 打开浏览器**无痕 / 隐私窗口**（推荐 Firefox）获取 Cookie：
   1. 访问 <https://gemini.google.com/app> 并登录 Google 账号；
   2. 按 `F12`（macOS 按 `⌥⌘I`）切到 **Network（网络）**，刷新页面；
   3. 点击任意 `gemini.google.com` 请求 → **Headers** → **Request Headers**，复制 `cookie` 的值粘贴回 Magpie；
   4. **直接关闭无痕窗口，不要点退出登录**（点退出会使 Cookie 失效）。
3. 插件验证账号可用后即完成登录。想添加更多账号，重复上述步骤即可。

> **为什么必须用无痕窗口？** 后端会定时刷新会话来保活。若与日常浏览器共用同一登录会话，Google 会将整个会话作废，导致你的浏览器退出所有 Google 服务。使用无痕窗口（或单独准备 Google 小号）可提供独立会话。

---

## 多账号与额度卡片

- **一账号一卡片**：每个 Google 账号单独生成一张以邮箱命名的额度卡片。
  - *旧版迁移（Gemini Web）*：若后端里已有早期版本添加的账号，在登录时选 **「添加本地后端里已有的 Google 账号」** 即可生成独立卡片，随后可删掉旧的 `API key …` 汇总卡片。
- **账号池自动调度**：请求实际使用哪个账号由本地后端决定（Gemini Web 在账号池中轮流挑选；AI Studio 先用一个，进入冷却再切下一个）。在 Magpie 界面切换卡片不会改变后端的账号调度。
- **用量刷新说明**：
  - `gemini-web`：仅一键配置的本地后端可读取用量。为减少向 Google 发请求，仅在账号被使用或窗口重置后低频刷新（最短间隔 10 分钟，闲置时最多 6 小时刷新一次）。
  - `ai-studio`：AI Studio 不提供剩余总额度，卡片会展示当前账号正在冷却的模型、恢复时间或重新登录提示。

---

## 配置与进阶

<details>
<summary><b>⚙️ 插件选项与代理配置</b>（开启图片输入、设置代理、连接自建后端）</summary>

<br>

工具调用默认开启，图片输入默认关闭。可通过命令行修改插件配置：

```bash
# 开启图片输入（对两个 Provider 生效）
magpie plugin options magpie-gemini-web '{"allowImages":true}'

# 为 AI Studio 配置代理
magpie plugin options magpie-gemini-web '{"studio":{"proxy":"http://127.0.0.1:7890"}}'
```

| 选项 | 默认值 | 适用范围 | 说明 |
| :--- | :--- | :--- | :--- |
| `allowTools` | `true` | 共用（可用 `studio.allowTools` 单独覆盖） | 允许工具调用。设为 `false` 时带工具的请求返回 400 |
| `allowImages` | `false` | 共用（可用 `studio.allowImages` 单独覆盖） | 允许图片输入 |
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | 共用（`studio.*` 可覆盖） | 单次等待后端 / 拉取模型列表的超时（毫秒），持续流式输出时不会被打断 |
| `stripCitations` | `true` | 仅 `gemini-web` | 剥离回复与工具参数中的 `[cite: 1]`、`[cite_start]` 标记（AI Studio 不支持剥离） |
| `baseURL` | `http://127.0.0.1:8083/v1` | 仅 `gemini-web` | Gemini Web 默认后端地址 |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | 仅 `gemini-web` | 向客户端声明的上下文 / 输出上限 |
| `studio.proxy` | 无 | 仅 `ai-studio` | 访问 Google 的代理（`http` / `https` / `socks5`），也可用环境变量 `AI_STUDIO_PROXY` |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | 仅 `ai-studio` | 连接已有 AIStudio2API 时的默认地址 |
| `studio.contextLimit` / `studio.outputLimit` | 模型目录默认值 | 仅 `ai-studio` | 向客户端声明的上限（仅支持在目录值基础上调低） |

**配置代理访问 Google：**
- **AI Studio**：配置上表中的 `studio.proxy` 或环境变量 `AI_STUDIO_PROXY`。
- **Gemini Web**：后端不读取 `HTTP_PROXY`，请打开本地管理面板 `http://127.0.0.1:8083/admin` 在代理池中添加（登录口令为数据目录 `secrets.json` 中的 `adminToken`）。
  - *注意*：配置代理池后，新添加的账号需先发送一次请求以绑定代理，再通过「添加本地后端里已有的 Google 账号」重新添加，才能正常读取邮箱和用量（不支持通过 SOCKS 代理读取用量）。

**连接自建后端：**
如果你自己运行了 `gemini-web2api-go` 或 `AIStudio2API`，登录时选择 **「连接已有后端 / 连接已有 AIStudio2API」**，填入以 `/v1` 结尾的地址和对应的 API Key 即可。

**刷新模型列表：**
升级插件后，可执行 `magpie provider models gemini-web` 刷新模型列表。

</details>

<details>
<summary><b>🛠️ AI Studio 命令行工具</b>（查看状态、重新登录、离线安装）</summary>

<br>

当插件报错提示运行命令时，直接复制报错中的完整命令执行即可。在插件目录下也可使用：

| 命令 | 作用 |
| :--- | :--- |
| `npm run studio:status` | 查看本地服务与账号状态 |
| `npm run studio:start` / `studio:stop` | 启动 / 停止本地服务 |
| `npm run studio:login` | 添加 Google 账号 |
| `npm run studio:relogin -- [<账号>]` | 重新登录过期账号（仅一个账号时可省略参数） |
| `npm run studio:install -- --archive <文件>` | 使用已下载的安装包离线安装 |
| `node scripts/studio.mjs import <目录>` | 在服务停止状态下导入已有账号 |
| `npm run studio:smoke` | 发起真实请求验收（会消耗账号额度） |

</details>

<details>
<summary><b>🔒 安全、数据目录与后端版本管理</b>（日志位置、升级与回退、macOS 原生 Task）</summary>

<br>

**安全与数据目录：**
- 两个后端均只监听 `127.0.0.1`，Cookie 与登录态仅保存在本机，Magpie 仅保存本地生成的随机 API Key。
- **Gemini Web 数据目录**：`~/.local/share/magpie-gemini-web`（可通过 `GEMINI_WEB_DATA_DIR` 修改），日志位于 `backend.log`。支持 macOS、Linux、Windows（x64 / arm64）。
- **AI Studio 数据目录**：`~/.local/share/magpie-ai-studio`（可通过 `AI_STUDIO_DATA_DIR` 修改），日志位于 `backend.log`（超 10 MB 下次启动自动轮转）。默认使用 2048 端口，被占用时自动顺延并记录在 `config.json`。支持 macOS、Linux（x64 / arm64）与 Windows x64。
- 插件将请求并发限制为 1，但仍无法完全排除 Google 账号风控风险，请自行评估使用。

**Gemini Web 优化后端升级与回退：**
- 插件默认使用本仓库发布的 [4.22.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.22.0-magpie.1)（基于上游 v4.22.0 集成 XSRF 缓存、请求取消传播、工具调用提前收尾与 Argon 校验补丁）。
- **旧版升级**：插件不会打断运行中的后端。先停止旧进程（PID 见数据目录 `backend.pid`），下次启动 Magpie 或发请求时会自动更新二进制并保留原有配置与账号。
- **回退官方版 / 恢复优化版**（停止后端后在插件目录执行）：
  ```bash
  npm run backend:install:upstream  # 回退并固定使用官方 v4.22.0
  npm run backend:install           # 恢复默认优化版
  ```
- 源码复现构建与发布流程见 [docs/backend-release.md](docs/backend-release.md)。

**macOS 原生 Task（实验性）：**
macOS 用户登录 Gemini Web 时会额外看到「macOS 原生 Task（实验性）」选项，通过本机 `Gemini.app` 的原生 Task 通道调用 `gemini-task-argon`（原生 Function Calling）。当前处于 Alpha 阶段，需预先完成本机配置，详见 [native-task/README.md](native-task/README.md)。

</details>

---

## 友链

[LINUX DO](https://linux.do/) — 真诚、友善、团结、专业的技术社区。

## 许可证

MIT。上游 `gemini-web2api-go` 同为 MIT（见 `LICENSE-UPSTREAM`）。

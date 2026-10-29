# <img src="docs/logo.svg" width="28" height="28" align="top" alt="" /> magpie-gemini-web

[![npm version](https://img.shields.io/npm/v/magpie-gemini-web?style=flat-square&logo=npm&color=4f46e5)](https://www.npmjs.com/package/magpie-gemini-web) [![npm downloads](https://img.shields.io/npm/dw/magpie-gemini-web?style=flat-square&color=06b6d4)](https://www.npmjs.com/package/magpie-gemini-web) [![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-3b82f6?style=flat-square)](https://usemagpie.ai/) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-8b5cf6?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/) [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6366f1?style=flat-square)](https://github.com/BUKOWSKIREAL/magpie-gemini-web) [![License: MIT](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](LICENSE)

中文 | [English](README.en.md)

让 [Magpie](https://usemagpie.ai/) 通过你的 Google 账号使用 **Google AI Studio** 与 **Gemini 网页版**。插件在本机自动运行 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) 与 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)，将网页端能力转为 OpenAI 兼容接口。

> **2026-10-16 更新**：正价支付的 Google AI Pro 现可直接在 Antigravity 中使用 `gemini-4-argon`，同理也可直接用 Magpie 反代。

## 怎么选？

插件提供两个互相独立的 Provider，可按使用场景选择（也可同时配置）：

| 对比项 | Google AI Studio (`ai-studio`) | Gemini Web (`gemini-web`) |
| :--- | :--- | :--- |
| **适用场景** | **推荐 Coding Agent 使用** | 日常对话、使用网页版专属模型与额度 |
| **工具调用** | **原生 Function Calling**，稳定可靠 | 提示词模拟（实验性，Flash 系列常不调工具） |
| **思考档位** | 按模型目录提供 `minimal` / `low` / `medium` / `high` 中支持的档位 | `low`（普通）/ `medium`（`-thinking-medium`，仅 `gemini-4-argon`）/ `high`（`-thinking` 扩展思考） |
| **登录方式** | 弹出独立浏览器窗口直接登录 Google | 用无痕窗口登录并复制 `cookie` |
| **额度卡片** | 显示冷却中的模型与恢复时间 | 同步网页版 **5 小时** 与 **每周** 用量及重置时间 |
| **本地后端** | AIStudio2API (`v0.2.17`) | gemini-web2api-go (`4.26.0-magpie.1` 优化版) |

---

## 快速开始

在 Magpie 插件市场安装 **magpie-gemini-web** 后，按需登录以下任一（或两个）Provider。插件会自动下载对应后端、校验 SHA-256 并在后台自启，无需安装 Go 或其它依赖。

### 方式一：Google AI Studio (`ai-studio`)

1. 在 Magpie 中登录 **Google AI Studio**，选择 **「用 Google 账号登录（推荐）」**。
2. 在弹出的独立登录窗口中登录 Google 账号（不影响日常浏览器），完成后直接关闭窗口。
   > 首次使用要先下载本地服务（约 30 MB）和登录浏览器 Camoufox（约 300 MB），弹窗可能需要等几分钟才出现。需要下载时，Magpie 会在浏览器里打开一个进度页，显示下载进度。Magpie 最多等 10 分钟（下载的时间也算在内），请尽快完成登录；连不上 GitHub 时，先按下面「插件选项与代理配置」设置 `studio.proxy`。
3. **后续管理**：再次点击「用 Google 账号登录」，可选择**添加新账号**、为本机已有账号建卡，或为过期账号**重新登录**。

### 方式二：Gemini Web (`gemini-web`)

1. 在 Magpie 中登录 **Gemini Web**，选择 **「一键配置本地 Gemini Web（推荐）」**（若访问 Google 需要代理，可在第一步提示中直接填写代理地址，例如 `http://127.0.0.1:7890`，无需代理或已配置代理池可留空）。
2. 打开浏览器**无痕 / 隐私窗口**（推荐 Firefox）获取 Cookie：
   1. 访问 <https://gemini.google.com/app> 并登录 Google 账号；
   2. 按 `F12`（macOS 按 `⌥⌘I`）切到 **Network（网络）**，刷新页面；
   3. 点击任意 `gemini.google.com` 请求 → **Headers** → **Request Headers**，复制 `cookie` 的值粘贴回 Magpie；
   4. **直接关闭无痕窗口，不要点退出登录**（点退出会使 Cookie 失效）。
3. 插件验证账号可用后即完成登录。想添加更多账号，重复上述步骤即可。

> **升级后提示后端不支持登录时绑定代理？** 旧后台进程可能仍在运行。请按提示先退出 Magpie，停止对应的 `gemini-web2api-go` 进程（Windows：任务管理器 → 详细信息 → `gemini-web2api-go.exe`），再运行提示中的完整安装命令。它会保留账号和配置，并切换到插件的托管后端；如下载需要代理，先设置 `GEMINI_WEB_PROXY`。完成后重新打开 Magpie 登录。

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

> **Windows PowerShell**：`magpie` 实际运行的是 `magpie.cmd` 包装器，它转发参数时会弄丢 JSON 里的双引号。请直接调用它背后的可执行文件：这个文件和 `magpie.cmd` 在同一个文件夹（`where.exe magpie` 可以找到），文件名可能是 `magpie-windows-amd64.exe` 之类，Magpie 的「设置 → 命令行」里也会显示。写法取决于 PowerShell 版本（用 `$PSVersionTable.PSVersion` 查看）：
> - PowerShell 7.3 及以上，默认设置：`& "<可执行文件的完整路径>" plugin options magpie-gemini-web '{"allowImages":true}'`
> - Windows PowerShell 5.1（系统自带）：它不会替你转义参数里的双引号，要写成 `\"`：`& "<可执行文件的完整路径>" plugin options magpie-gemini-web '{\"allowImages\":true}'`

| 选项 | 默认值 | 适用范围 | 说明 |
| :--- | :--- | :--- | :--- |
| `allowTools` | `true` | 共用（可用 `studio.allowTools` 单独覆盖） | 允许工具调用。设为 `false` 时带工具的请求返回 400 |
| `allowImages` | `false` | 共用（可用 `studio.allowImages` 单独覆盖） | 允许图片输入 |
| `requestTimeoutMs` / `modelTimeoutMs` | Web：`240000` / `10000`；Studio：`1800000` / `10000` | 共用（`studio.*` 可覆盖） | 单次等待后端 / 拉取模型列表的超时（毫秒）；收到流数据后重新计时，显式配置优先 |
| `stripCitations` | `true` | 仅 `gemini-web` | 剥离回复与工具参数中的 `[cite: 1]`、`[cite_start]` 标记（AI Studio 不支持剥离） |
| `proxy` | 无 | 仅 `gemini-web` | 一键配置后端访问 Google 的代理（`http` / `https` / `socks5` / `socks5h`），也可用环境变量 `GEMINI_WEB_PROXY` 或在登录第一步填写 |
| `baseURL` | `http://127.0.0.1:8083/v1` | 仅 `gemini-web` | Gemini Web 默认后端地址 |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | 仅 `gemini-web` | 向客户端声明的上下文 / 输出上限 |
| `studio.proxy` | 无 | 仅 `ai-studio` | 访问 Google 的代理（`http` / `https` / `socks5`），也可用环境变量 `AI_STUDIO_PROXY`；设置后优先于管理页里保存的代理，留空等于不设置 |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | 仅 `ai-studio` | 连接已有 AIStudio2API 时的默认地址 |
| `studio.contextLimit` / `studio.outputLimit` | 模型目录默认值 | 仅 `ai-studio` | 向客户端声明的上限（仅支持在目录值基础上调低） |

**配置代理访问 Google：**
- **AI Studio**：推荐在本地管理页设置。打开额度卡片「管理页」一行里的地址（默认 `http://127.0.0.1:2048`），用户名 `magpie`，密码是数据目录 `config.json` 里的 `adminPassword`；保存代理后在管理页重启服务即可生效，之后插件重启后端也不会覆盖它。
  - 也可以用上表的 `studio.proxy` 或环境变量 `AI_STUDIO_PROXY`，它们优先于管理页里保存的代理。改了要重启本地服务才生效（`npm run studio:stop`，下一次请求会自动启动）。
  - 都没设置时，后端直连；macOS 和 Windows 上会使用已配置的系统代理。
  - **后端不使用 Magpie 的代理（包括给 `ai-studio` 设置的供应商代理），也不读取 `HTTPS_PROXY` 等环境变量**：它在 Magpie 退出后仍会运行，借用 Magpie 的代理到时可能已经失效。请用上面两种方式之一设置。加入这项修复之前的插件版本启动的后端，可能还在用启动时环境变量里的代理（比如 Magpie 的）；「代理出口」一行会标出来，并说明重启后会怎样。
  - 额度卡片的「代理出口」一行会显示后端当前实际使用的代理、它来自哪里，以及新设置是否还要重启才生效；登录 Google 时的说明、登录失败的提示和 `npm run studio:status` 也会显示。
  - 监听地址、API Key、管理员账号等由插件管理，在管理页修改不会生效。
- **Gemini Web**：后端不读取系统代理或 `HTTP_PROXY`。可在「一键配置本地 Gemini Web」登录第一步直接填写代理地址，或设置插件选项 `proxy` / 环境变量 `GEMINI_WEB_PROXY`，也可以打开本地管理面板 `http://127.0.0.1:8083/admin` 在代理池中添加（登录口令为数据目录 `secrets.json` 中的 `adminToken`）。
  - *注意*：配置代理池后，新添加的账号需先发送一次请求以绑定代理，再通过「添加本地后端里已有的 Google 账号」重新添加，才能正常读取邮箱和用量（不支持通过 SOCKS 代理读取用量）。

**连接自建后端：**
如果你自己运行了 `gemini-web2api-go` 或 `AIStudio2API`，登录时选择 **「连接已有后端 / 连接已有 AIStudio2API」**，填入以 `/v1` 结尾的地址和对应的 API Key 即可。

**刷新模型列表：**
升级插件后，可执行 `magpie provider models gemini-web` 刷新模型列表。

</details>

<details>
<summary><b>🛠️ AI Studio 命令行工具</b>（查看状态、重新登录、离线安装）</summary>

<br>

**本地服务什么时候启动、停止：**
- 插件加载时（例如打开 Magpie）会在后台启动本地服务；之后发请求、刷新额度卡片时，服务没在运行也会自动启动。
- 本地服务是独立进程，**退出 Magpie 不会停止它**，下次打开 Magpie 直接接着用。
- 停止服务用下表的 `studio:stop`（或卡片、报错里给出的完整命令）。停止只是一次性的：下一次请求会再次启动它。

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

**AI Studio 升级与模型范围：**
- 插件固定使用经过 SHA-256 校验的 `v0.2.17-magpie.1`（基于上游 `v0.2.17`），通过升级插件更新后端。同基线或更旧的官方版、以及旧版插件装的托管后端，在下次管理启动时自动升级，保留账号、端口与登录凭据。
- **托管后端已在 macOS、Linux、Windows 统一禁用在线更新**：管理页提示“更新由 magpie-gemini-web 管理”，更新接口返回 HTTP 409，检查更新也不会访问 GitHub。用户自行连接的外部服务不受影响。托管构建方式和可复现构建流程见 [docs/studio-release.md](docs/studio-release.md)。
- Unix 的 `package/` 仍尽力设置为 `0555`，作为额外的文件保护；权限设置失败不阻断服务，在线更新的禁用也不依赖该权限。若要手动删除数据目录来重置，请先停止服务，再运行 `chmod -R u+w "<数据目录>/package"` 恢复可写权限，然后删除；将 `<数据目录>` 替换为实际路径。
- 若自行更新到更新版或定制版，插件会提示版本冲突，并提供带正确 `--data-dir` 的 `stop`、`install`、`start` 命令。停止时会找回更新后的监听进程 PID，并核对可执行文件路径；无法核实身份就不会发送终止信号。HTTP 端口关闭但进程尚未退出时，插件不会重装或启动第二个进程。
- 已停止但文件被替换的后端会从校验通过的固定版本安装包恢复；校验失败不会启动替换文件。安装会保留账号和运行数据文件，但**不保证旧版本能读取新版迁移过的数据**。手动降级前先停止服务并备份整个数据目录（包括 `auth/`、`runtime/requests.db` 等）；已知发生数据迁移时应升级插件以匹配新版后端。
- AI Studio 后端基础请求期限为 30 分钟；插件默认单次响应等待／流空闲超时也是 30 分钟（仍可用 `studio.requestTimeoutMs` 调整）。这允许非流式长回复在服务端完整收集；后端卡死时也可能等满 30 分钟，且单 worker 会拖住后续请求。可主动取消请求或设置更短的等待时间，但较短期限可能中断正常长回复。上游自动续写的期限按其规则计算。
- 已核对本机 Magpie `v0.1.1285`（`d783df46`）源码：插件请求走 `Provider.Do → plugin.Fetch → loader.fetch`，绕过普通 HTTP transport 的 10 分钟响应头限制；此插件生成路径没有发现更短的固定总超时。网关 5 分钟 `IdleTimeout` 仅针对请求之间的空闲连接。客户端或反向代理仍可设置更短期限；这不是一次实等 30 分钟的端到端验证。
- 模型列表过滤 `-build` / `assistant_route` 模型：这类模型附带 Build 写代码助手的系统提示词，不作为普通 Agent 模型提供。升级后可执行 `magpie provider models ai-studio` 刷新列表。

**Gemini Web 优化后端升级与回退：**
- 插件默认使用本仓库发布的 [4.26.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.26.0-magpie.1)（基于上游 v4.26.0 集成 XSRF 缓存、请求取消传播、工具调用提前收尾与 Argon 校验补丁）。
- **旧版升级**：插件不会打断运行中的后端。先停止旧进程（PID 见数据目录 `backend.pid`），下次启动 Magpie 或发请求时会自动更新二进制并保留原有配置与账号。
- **回退官方版 / 恢复优化版**（停止后端后在插件目录执行）：
  ```bash
  npm run backend:install:upstream  # 回退并固定使用官方 v4.26.0
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

---

## Star 趋势

<p align="center">
  <a href="https://www.star-history.com/#BUKOWSKIREAL/magpie-gemini-web&amp;Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BUKOWSKIREAL/magpie-gemini-web&amp;type=Date&amp;theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BUKOWSKIREAL/magpie-gemini-web&amp;type=Date" />
      <img alt="magpie-gemini-web 的 GitHub Star 增长趋势" src="https://api.star-history.com/svg?repos=BUKOWSKIREAL/magpie-gemini-web&amp;type=Date" width="800" />
    </picture>
  </a>
</p>

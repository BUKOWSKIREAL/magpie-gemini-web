# magpie-gemini-web

中文 | [English](README.en.md)

让 [Magpie](https://usemagpie.ai/) 通过你的 Google 账号使用 Gemini 网页版与 Google AI Studio。插件在本机运行 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) 与 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) 后端，把 Google 网页转成 OpenAI 兼容接口。

插件提供两个互相独立的 Provider：
- `gemini-web`：Gemini 网页版，见下面的[开始使用](#开始使用-gemini-web)；
- `ai-studio`：Google AI Studio，原生工具调用，见 [Google AI Studio](#google-ai-studio-ai-studio)。

> **2026-10-16 更新**：现在正价支付的 Google AI Pro 可以直接在 Antigravity 中使用 `gemini-4-argon`，同理也可以直接用 Magpie 反代。

## 开始使用 (Gemini Web)

1. 在 Magpie 插件市场安装 **magpie-gemini-web**。
2. 登录 Gemini Web，选 **「一键配置本地 Gemini Web（推荐）」**。插件会自动下载本项目发布的优化后端、校验 SHA-256，并在后台启动；不需要安装 Go 或手动打补丁。
3. 按提示复制 Cookie，**一定要用无痕 / 隐私窗口**（推荐 Firefox）：
   1. 在无痕窗口打开 <https://gemini.google.com/app>，登录要使用的 Google 账号；
   2. 按 F12（macOS 按 ⌥⌘I），切到 **Network（网络）**，刷新页面；
   3. 点任意一个 `gemini.google.com` 请求 → **Headers（标头）** → **Request Headers（请求标头）**；
   4. 复制 `cookie` 那一行的值，粘贴回 Magpie；
   5. 直接关掉无痕窗口，**不要点退出登录**（退出会让这份 Cookie 失效）。
4. 插件检测账号可用后自动完成登录。

> **为什么要用无痕窗口？** 后端会定时刷新这份登录来保活。如果它和你平时用的浏览器是同一个登录会话，Google 会把会话作废，你的浏览器就会退出所有 Google 服务。无痕窗口能给后端一份独立的会话；更稳妥的做法是给后端单独用一个 Google 小号。

之后 Magpie 每次启动都会自动拉起后端，不用再管。想加更多账号，再走一遍一键配置即可。

> 需要代理才能访问 Google？后端不读 `HTTP_PROXY`，请在管理面板 `http://127.0.0.1:8083/admin` 的代理池里添加（登录口令是数据目录 `secrets.json` 里的 `adminToken`）。

**连接已有后端**：如果你自己运行了 gemini-web2api-go，登录时选「连接已有后端（自定义地址 + API key）」，填后端地址（以 `/v1` 结尾）和它的 `API_KEY`。

## 插件选项 (Gemini Web)

工具调用默认开启（Coding Agent 每个请求都带工具），图片输入默认关闭。需要图片输入时：

```bash
magpie plugin options magpie-gemini-web '{"allowImages":true}'
```

| 选项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `allowTools` | `true` | 允许工具调用（实验性，由上游用提示词模拟）。设为 `false` 时带工具的请求会返回 400 |
| `allowImages` | `false` | 允许图片输入 |
| `baseURL` | `http://127.0.0.1:8083/v1` | 默认后端地址 |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | 向客户端声明的上下文 / 输出上限 |
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | 请求 / 拉取模型列表的超时（毫秒）。请求超时按每次等待后端计算，回复持续输出时不会被打断 |
| `stripCitations` | `true` | 去掉 Gemini 在回复里加的引用标记 `[cite: 1]`、`[cite_start]`（包括工具调用参数）。让 Gemini 编辑本身含有这类文本的代码时，可以设为 `false` |

## 思考档位

有 `-thinking` 版本的模型可以在 Magpie 里切换 `low` / `high`：`low` 用普通模型，`high` 用 `-thinking` 模型（扩展思考）。`-thinking` 模型因此不再单独列出。升级插件后执行 `magpie provider models gemini-web` 刷新模型列表。Argon 的「中」档等上游支持（[#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)）。

## 安全与数据

- 后端只监听 `127.0.0.1`；Cookie 只交给本机后端，Magpie 保存的是本地生成的 API key。
- 默认后端为本项目发布的 **4.22.0-magpie.1**，基于固定的上游 v4.22.0 源码应用本仓库补丁。下载和启动新进程前校验 SHA-256。支持 macOS、Linux、Windows（x64 / arm64），发布页提供源码、构建记录和校验和。
- 数据目录：`~/.local/share/magpie-gemini-web`（可用 `GEMINI_WEB_DATA_DIR` 修改），日志在 `backend.log`。
- 插件限制并发为 1，但无法保证账号不被 Google 风控，请自行承担风险。

## 用量

Magpie 的额度卡片会显示 Google 账号的 **5 小时** 和 **每周** 用量与重置时间，和 <https://gemini.google.com/usage> 页面一致。每个 Google 账号单独一张卡片，标题是它的邮箱：

- 一键配置添加的账号会自动成为单独的一张卡片；
- 后端里已有的账号（比如旧版本添加的），在 Magpie 里给 Gemini Web 再添加一个账号，选 **「添加本地后端里已有的 Google 账号」**，从列表里选择即可。之后可以删掉旧的 `API key …` 登录，它显示的是整个账号池合在一起的用量（每个窗口取用得最多的那个账号）。

注意：请求最终由后端在账号池里轮流挑选 Google 账号，Magpie 在几张卡片之间怎么分配请求，不决定实际用的是哪个账号。只有一键配置的本地后端能显示用量；「连接已有后端」模式下读不到账号的 Cookie。

为了少向 Google 发请求，用量不会每次刷新都去查：账号经后端用过、或者某个窗口到了重置时间，才重新读取，两次至少间隔 10 分钟；账号闲着时最多每 6 小时读一次（顺带反映你在 Gemini 网页里的用量）。

读取用量和邮箱时，走的是后端访问 Google 的同一个出口。出口不确定时不读取，卡片上会写明原因：

- 配了代理池，但账号还没绑定代理（后端在它第一次请求时绑定）；
- 账号绑定的代理已停用，或者是 SOCKS 代理。

所以配了代理池时，一键配置刚添加的账号暂时没有邮箱。先用它发一次请求，再用「添加本地后端里已有的 Google 账号」重新登录它，然后删掉没有邮箱的那个登录。

## 局限 (Gemini Web)

- 工具调用由上游用提示词模拟，不一定可靠，Flash 系列经常不调用工具。
- 只开放 `gemini-` 开头的文本模型；`cost` 显示为 0 不代表 Google 的实际配额。

## Google AI Studio (`ai-studio`)

通过 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)（固定 v0.2.12）使用 Google AI Studio。和 Gemini Web 相比，工具调用走原生 Function Calling，思考模型可以在 Magpie 里切换 `minimal` / `low` / `medium` / `high` 四档（`minimal` 最快、最省额度），日常生成不需要浏览器。

### 开始使用

1. 登录 Google AI Studio，选 **「一键配置本地 Google AI Studio（推荐）」**。插件会自动下载 AIStudio2API、校验 SHA-256 并在后台启动。
2. 在弹出的独立登录窗口里登录 Google 账号（不影响你平时用的浏览器），完成后关掉窗口即可。第一次要先下载登录用的浏览器 Camoufox，窗口可能要等几分钟才出现；需要在 15 分钟内完成登录。

想加更多账号，再走一遍一键配置。所有账号共用一张登录卡片：每个请求用哪个账号由本地服务决定，先用一个，冷却了再换下一个。

其他登录选项：

- **使用本机已有的 AI Studio 服务**：本机已经有账号（比如用命令行添加的）时直接登录，不打开登录窗口。
- **重新登录失效的 AI Studio 账号**：账号的 Google 登录过期后，在这里选中它重新登录。
- **连接已有 AIStudio2API**：你自己运行了 AIStudio2API 时，填它的地址（默认 `http://127.0.0.1:2048/v1`）和 `PROXY_API_KEY`。

额度卡片：AI Studio 不提供剩余额度，卡片显示账号池里的账号和正在冷却的模型。每个模型一条进度条，满格表示暂时没有账号能用它，旁边是恢复时间。

### 插件选项

`allowTools`、`allowImages`、`requestTimeoutMs`、`modelTimeoutMs` 两个 Provider 共用；其余 AI Studio 选项放在 `studio` 里，根级别的 `baseURL`、`contextLimit`、`outputLimit`、`stripCitations` 只对 Gemini Web 生效。

```bash
magpie plugin options magpie-gemini-web '{"studio":{"proxy":"http://127.0.0.1:7890"}}'
```

| 选项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `studio.proxy` | 无 | 访问 Google 用的代理（http / https / socks5）。也可以用环境变量 `AI_STUDIO_PROXY` |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | 「连接已有 AIStudio2API」的默认地址 |
| `studio.contextLimit` / `studio.outputLimit` | 模型目录的值 | 向客户端声明的上限，只会调低 |
| `studio.allowTools` 等 | 同根级别 | 只对 AI Studio 覆盖根级别的同名选项 |

AI Studio 的回复保留引用标记 `[cite: 1]`，不能去掉。

### 命令行

插件报错里需要你运行命令时，会给出带完整路径的命令，复制即可运行。在插件目录里也可以用：

| 命令 | 作用 |
| :--- | :--- |
| `npm run studio:status` | 查看服务和账号状态 |
| `npm run studio:start` / `studio:stop` | 启动 / 停止本地服务 |
| `npm run studio:login` | 添加 Google 账号 |
| `npm run studio:relogin -- [<账号>]` | 重新登录过期的账号（只有一个时可省略） |
| `npm run studio:install -- --archive <文件>` | 用下载好的安装包离线安装 |
| `node scripts/studio.mjs import <目录>` | 服务停止时导入已有账号 |
| `npm run studio:smoke` | 真实请求验收（会用掉账号额度） |

### 数据与安全

- 服务只监听 `127.0.0.1`，Magpie 保存的是本地生成的 API key。
- 数据目录：`~/.local/share/magpie-ai-studio`（可用 `AI_STUDIO_DATA_DIR` 修改）。日志在 `backend.log`，超过 10 MB 时下次启动换新。
- 第一次配置使用 2048 端口；被占用时（比如你自己也在跑 AIStudio2API）自动换一个，记在数据目录的 `config.json`。
- 下载的安装包留在数据目录，重装时校验通过就不再下载。
- 支持 macOS、Linux（x64 / arm64）和 Windows x64。

## macOS 原生 Task（实验性）

在 macOS 上登录时会多出一个「macOS 原生 Task（实验性）」选项：请求不走 Gemini Web 后端，而是交给本机常驻服务，由 Gemini.app 自己的 Task 模式执行，工具调用走原生的 Function Calling 通道，模型为 `gemini-task-argon`。Windows 和 Linux 上不会出现这个选项，请继续使用上面的一键配置。

当前为 Alpha：仅支持已验证的 Gemini.app 版本，选这个选项之前需要先在本机完成 setup（需要 Gemini.app 已登录，以及会话模板），只完成过一次真实 Argon 的工具往返验证，读不到额度；Agent 中途打断时，未回传结果的工具调用会占住唯一的 Task 名额最长约 4 分钟。配置步骤、会话要求和限制见 [native-task/README.md](native-task/README.md)。

## 默认优化后端与回退

从插件 **0.4.1** 起，一键配置默认使用 [4.22.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.22.0-magpie.1)。它包含原先需要手动编译的优化：稳定的 XSRF 缓存、主要生成与上传请求的取消传播、完整工具调用后的提前收尾、浏览器请求头，以及 Argon 返回模型校验。Google 账号仍需具备对应模型权限。

**已有用户升级**：插件不会中断正在运行的后端。先停止现有后端进程（进程 ID 在数据目录的 `backend.pid`），再启动 Magpie 或发送请求；停止状态的旧官方后端会自动更新，配置、Cookie 数据库和 API key 保留。已经手动安装的本地 Argon 构建会继续复用；要切到发布版，可在停止后端后运行下面的 `backend:install`。

需要回退时，在插件目录停止后端后运行：

```bash
npm run backend:install:upstream
```

这会安装经过 SHA-256 校验的官方 v4.22.0，并记住回退选择，之后自动启动也使用官方版。恢复默认优化版：

```bash
npm run backend:install
```

下载失败或校验不通过时保留旧二进制。Windows 上必须先停止旧进程，才能替换正在使用的可执行文件。

源码与构建记录随后端 Release 提供。开发者使用 Git、Node 22+、Go 1.27.1，可从本仓库复现全部六个平台的构建并核对哈希：

```bash
npm run backend:release:build
```

构建脚本从固定的上游提交提取干净源码、应用 `patches/argon.patch`，不会修改本地 `backend-source` 的工作内容。发布流程见 [docs/backend-release.md](docs/backend-release.md)。

## 友链

[LINUX DO](https://linux.do/) — 真诚、友善、团结、专业的技术社区。

## 许可证

MIT。上游 gemini-web2api-go 同为 MIT（见 `LICENSE-UPSTREAM`）。

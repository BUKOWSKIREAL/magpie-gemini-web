# magpie-gemini-web

中文 | [English](README.en.md)

让 [Magpie](https://usemagpie.ai/) 通过你的 Google 账号使用 Gemini 网页版。插件在本机运行 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) 后端，把 Gemini 网页转成 OpenAI 兼容接口。

> **2026-10-16 更新**：现在正价支付的 Google AI Pro 可以直接在 Antigravity 中使用 `gemini-4-argon`，同理也可以直接用 Magpie 反代。

## 开始使用

1. 在 Magpie 插件市场安装 **magpie-gemini-web**。
2. 登录 Gemini Web，选 **「一键配置本地 Gemini Web（推荐）」**。插件会自动下载并校验后端，在后台启动它。
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

## 插件选项

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
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | 请求 / 拉取模型列表的超时（毫秒） |
| `stripCitations` | `true` | 去掉 Gemini 在回复里加的引用标记 `[cite: 1]`、`[cite_start]`（包括工具调用参数）。让 Gemini 编辑本身含有这类文本的代码时，可以设为 `false` |

## 思考档位

有 `-thinking` 版本的模型可以在 Magpie 里切换 `low` / `high`：`low` 用普通模型，`high` 用 `-thinking` 模型（扩展思考）。`-thinking` 模型因此不再单独列出。升级插件后执行 `magpie provider models gemini-web` 刷新模型列表。Argon 的「中」档等上游支持（[#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)）。

## 安全与数据

- 后端只监听 `127.0.0.1`；Cookie 只交给本机后端，Magpie 保存的是本地生成的 API key。
- 后端二进制锁定官方 v4.22.0，下载和每次启动都校验 SHA-256。支持 macOS、Linux、Windows（x64 / arm64）。
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

## 局限

- 工具调用由上游用提示词模拟，不一定可靠，Flash 系列经常不调用工具。
- 只开放 `gemini-` 开头的文本模型；`cost` 显示为 0 不代表 Google 的实际配额。

## macOS 原生 Task（实验性）

在 macOS 上登录时会多出一个「macOS 原生 Task（实验性）」选项：请求不走 Gemini Web 后端，而是交给本机常驻服务，由 Gemini.app 自己的 Task 模式执行，工具调用走原生的 Function Calling 通道，模型为 `gemini-task-argon`。Windows 和 Linux 上不会出现这个选项，请继续使用上面的一键配置。

当前为 Alpha：仅支持已验证的 Gemini.app 版本，选这个选项之前需要先在本机完成 setup（需要 Gemini.app 已登录，以及会话模板），只完成过一次真实 Argon 的工具往返验证，读不到额度；Agent 中途打断时，未回传结果的工具调用会占住唯一的 Task 名额最长约 4 分钟。配置步骤、会话要求和限制见 [native-task/README.md](native-task/README.md)。

## Argon 增强版（可选）

官方后端已支持 `gemini-4-argon`（需付费 / Ultra 账号）。本仓库的补丁版额外校验返回的确实是 Argon（防止被静默降级），并降低延迟。它也让后端的请求更像浏览器：直连时每个请求都带齐 Chrome 请求头（官方版直连时，对话请求的 UA 是 `Go-http-client/2.0`），保活刷新 Cookie 后也不再立即重新抓取 `/app` 页面。需要 Go 1.26+：

```bash
git clone https://github.com/BUKOWSKIREAL/magpie-gemini-web.git && cd magpie-gemini-web
git clone https://github.com/zexadev/gemini-web2api-go.git backend-source
git -C backend-source checkout a65b1d1a5ac614c1b455857334b4f1c73ab8fcfb
git -C backend-source apply ../patches/argon.patch
npm run backend:build:argon
npm run backend:install:argon
```

安装后重启 Magpie 即可，插件会在后台启动 Argon 版（如有旧后端在运行，先 `kill $(cat ~/.local/share/magpie-gemini-web/backend.pid)`）。运行 `npm run backend:install` 可切回官方版。

`patches/argon.patch` 更新后（比如拉取了本仓库的新版本），需要在干净的源码上重新应用补丁并重新构建。停掉旧后端后，插件会在下一个请求时启动新版：

```bash
git -C backend-source checkout -- . && git -C backend-source clean -fdq
git -C backend-source apply ../patches/argon.patch
npm run backend:build:argon && npm run backend:install:argon
kill $(cat ~/.local/share/magpie-gemini-web/backend.pid)
```

## 友链

[LINUX DO](https://linux.do/) — 真诚、友善、团结、专业的技术社区。

## 许可证

MIT。上游 gemini-web2api-go 同为 MIT（见 `LICENSE-UPSTREAM`）。

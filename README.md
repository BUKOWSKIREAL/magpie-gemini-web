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
| **思考档位** | 按模型目录提供 `minimal` / `low` / `medium` / `high` / `xhigh`（Hydrogen）中支持的档位 | `low`（普通）/ `medium`（`-thinking-medium`，仅 `gemini-4-argon`）/ `high`（`-thinking` 扩展思考） |
| **图片输入** | 默认开启，对话模型可以读图 | 默认开启，对话模型可以读图（需登录态挂 Cookie） |
| **图片生成** | Nano Banana 系列模型，供 Magpie 的图片生成使用（需要 Magpie v0.1.2075+，见下文） | 不支持 |
| **登录方式** | 自动安装官方后端，导入账号后确认连接 | 用无痕窗口登录并复制 `cookie` |
| **额度卡片** | 显示冷却中的模型与恢复时间 | 同步网页版 **5 小时** 与 **每周** 用量及重置时间 |
| **本地后端** | AIStudio2API（自动安装并跟随官方稳定版） | gemini-web2api-go (`4.28.0-magpie.1` 优化版) |

---

## 快速开始

在 Magpie 插件市场安装 **magpie-gemini-web** 后，按需登录以下任一（或两个）Provider。默认由插件下载对应后端、校验 SHA-256 并在后台自启，无需安装 Go 或其它依赖。AI Studio 默认自动跟随官方最新稳定版，也可关闭自动更新、指定自己的程序或连接独立服务。

### 方式一：Google AI Studio (`ai-studio`)

1. 在 Magpie 中登录 **Google AI Studio**，选择 **「添加账号并连接（推荐）」**。
2. 首次使用时，插件会**自动下载、校验并启动官方 AIStudio2API 最新稳定版**。无需手动下载程序、填写路径、复制 API key 或设置管理员密码。
3. 按连接页提示点击 **「打开账号管理页」**，在后端页面添加 Google 账号，可选择 Chrome 导入、Cookie 导入或浏览器登录。
4. 返回连接页，选择刚添加的账号并点击 **「连接到 Magpie」**。继续使用原有的 `ai-studio` Provider、模型、图片生成和额度卡片；添加更多账号时重复登录即可。

已有账号提示登录过期时，在 Magpie 中选择该账号，再按连接页指引到管理页点击原账号的「重新登录」，完成后返回确认。

以后启动先复用已安装的程序。**默认自动跟随官方最新稳定版**：Magpie 运行期间在后台检查更新，成功检查后缓存一小时；下载校验完成后，等待生成请求（包括流式响应）、账号登录和浏览器准备结束，再更新并重启。账号、端口、凭据和设置保留，无需等待插件发布新版。检查或下载失败时继续使用旧版；新程序启动失败时尝试回滚，并暂停重试该发行包。

需要自行决定版本时，运行 `npm run studio:updates -- manual`；恢复自动更新用 `npm run studio:updates -- auto`。高级路径和独立服务始终由用户管理。

浏览器登录需要下载 Camoufox（v0.3.7 约 1.3 GB）；Chrome / Cookie 导入可直接使用已有登录状态。Magpie 的单次连接等待上限为 10 分钟。网络较慢时，可先在已打开的官方账号管理页完成下载和登录；该页的后台任务不会因 Magpie 连接超时而取消，准备完成后再回到 Magpie 发起连接并选择已有账号。也可先在插件目录运行 `npm run studio:prepare-browser`，把浏览器下载放在登录计时之外；命令最多等待一小时，退出命令不会停止后端下载。连不上 GitHub 时先设置 `studio.proxy` 或 `AI_STUDIO_PROXY`。**「直接打开 Google 登录窗口」**仍可用于独立浏览器登录。已有后端若提供 Magpie 任务关联能力，仍可自动完成账号连接。

自动安装支持 macOS / Linux 的 x64、arm64 和 Windows x64。macOS / Linux 使用官方 CLI 包；Windows 官方包是桌面可执行文件，默认放在数据目录根部，与 `.env` 和 `runtime/` 相邻，以保留其设置。Windows arm64 尚无官方原生包，请用高级路径选择系统可以运行的兼容程序（例如 x64 程序），或连接独立后端；插件会在查询下载前提示。

**已有安装与版本选择：**

- 已有账号、端口、连接凭据和 Magpie 卡片继续使用。默认目录的旧 `-magpie` 构建也可由插件自动迁移到较新的官方稳定版；其内置更新限制无需用户解除。若旧版缺少用于确认空闲的管理接口，插件会暂缓自动更新。需要立即手动切换时，先退出 Magpie，在插件目录执行以下命令，再重新打开 Magpie：

  ```bash
  npm run studio:stop
  npm run studio:install                 # 当前官方最新稳定版
  npm run studio:start
  ```

- 指定官方版本：停止后执行 `npm run studio:install -- --version v0.3.7`。这会校验官方 SHA-256 并切换为手动更新，保留你的版本选择；需要再次跟随最新版时运行 `npm run studio:updates -- auto`。不会按历史安装哈希恢复文件，也不会自动降级已运行的较新版本。降级前应备份整个数据目录，因为旧版未必能读取新版迁移的数据。
- **高级选项**：已有自己的程序时，可选「指定 AIStudio2API 程序路径（高级）」或运行 `npm run studio:use -- "/完整路径/aistudio2api"`。使用 [官方安装包](https://github.com/Mag1cFall/AIStudio2API/releases) 解压后的程序，放在插件和 AI Studio 数据目录之外；切换前停止原服务。缺失的自备程序会明确报错，不会被重新下载覆盖。`studio:use-default` 可切回默认安装目录，已有程序继续复用，尚无程序时自动下载官方版。
- 已有 `config.json` 的安装首次迁移时，仅补齐缺失的旧设置：`SEARCH_MODEL_ALIASES=false`、每账号并发／预热 Worker／最大 Worker／启动预热并发均为 `1`、`ROUTING_STRATEGY=fill-first`、`REQUEST_TIMEOUT=30m`，并保留原有关闭备用请求等默认行为；显式值和未知配置键原样保留。迁移只执行一次，之后管理页保存的选择（包括由上游省略的默认值）不会被重新补写。
- 新安装沿用官方默认值。v0.3.7 默认开启搜索模型别名、每账号并发为 2、预热 10／最大 20 个 Worker、使用 round-robin；生成后端当前默认为 SpiderMonkey。以后选用的版本若改变 `WAA_BACKEND` 默认值，生成也可能需要 Camoufox 等浏览器组件；可在管理页明确指定设置。
- 插件维护本地连接和账号访问，其余设置由后端管理页控制，包括新版新增的配置项。卸载或 `studio:clean` 会清理默认目录中下载的程序、保留账号与配置；选择自备路径时会保留该进程、程序和整个数据目录，停止请使用 `studio:stop`。

如果希望独立运行服务，也可选 **「连接已有 AIStudio2API（地址 + API key）」**。连接官方 v0.3.7 时，Hydrogen Extra High 会映射为 Magpie 的 `xhigh` 档位。

### 方式二：Gemini Web (`gemini-web`)

1. 在 Magpie 中登录 **Gemini Web**，选择 **「一键配置本地 Gemini Web（推荐）」**（若访问 Google 需要代理，可在第一步提示中直接填写代理地址，例如 `http://127.0.0.1:7890`，无需代理或已配置代理池可留空）。
2. 按提示填写 **Google 账号索引**：复制 Cookie 的同一窗口地址若为 `/u/4/app`，填 `4`；单账号会话可留空（`0`）。无痕窗口中的索引可能不同，不能直接沿用日常窗口的编号。然后在浏览器**无痕 / 隐私窗口**（推荐 Firefox）获取 Cookie：
   1. 访问 <https://gemini.google.com/app> 并登录 Google 账号；
   2. 按 `F12`（macOS 按 `⌥⌘I`）切到 **Network（网络）**，刷新页面；
   3. 点击任意 `gemini.google.com` 请求 → **Headers** → **Request Headers**，复制 `cookie` 的值粘贴回 Magpie；
   4. **直接关闭无痕窗口，不要点退出登录**（点退出会使 Cookie 失效）。
3. 插件验证账号可用后即完成登录。想添加更多账号，重复上述步骤即可。

> **升级后提示后端不支持登录时绑定代理？** 旧后台进程可能仍在运行。请按提示先退出 Magpie，停止对应的 `gemini-web2api-go` 进程（Windows：任务管理器 → 详细信息 → `gemini-web2api-go.exe`），再运行提示中的完整安装命令。它会保留账号和配置，并切换到插件的托管后端；如下载需要代理，先设置 `GEMINI_WEB_PROXY`。完成后重新打开 Magpie 登录。

> **为什么必须用无痕窗口？** 后端会定时刷新会话来保活。若与日常浏览器共用同一登录会话，Google 会将整个会话作废，导致你的浏览器退出所有 Google 服务。使用无痕窗口（或单独准备 Google 小号）可提供独立会话。

---

## 多账号与额度卡片

- **账号额度卡片**：单个 Google 账号以邮箱命名；AI Studio 批量导入以账号组建卡，不同组独立统计，重复导入同组不会因账号顺序变化而新增卡片。
  - *旧版迁移（Gemini Web）*：若后端里已有早期版本添加的账号，在登录时选 **「添加本地后端里已有的 Google 账号」** 即可生成独立卡片，随后可删掉旧的 `API key …` 汇总卡片。
- **账号池自动调度**：请求实际使用哪个账号由本地后端决定（Gemini Web 在账号池中轮流挑选；AI Studio 先用一个，进入冷却再切下一个，可在管理页或通过 `studio.accountOrder`、`studio.modelAccounts` 指定账号优先顺序与模型专属账号池）。在 Magpie 界面切换卡片不会改变后端的账号调度。
- **用量刷新说明**：
  - `gemini-web`：仅一键配置的本地后端可读取用量。Magpie 每次来查都会向 Google 重新读取（同一账号 30 秒内只读一次），点刷新即显示最新额度，包括在 Gemini 官方 App、网页或其他设备上的用量。Magpie 自己来查的频率：用量页或菜单栏的额度面板开着时约每分钟一次；菜单栏显示任何一家额度时随菜单栏更新（默认每 3 分钟）；经 Magpie 转发请求时最多每分钟一次；都没有时不查。读取失败后 10 分钟内不自动重试，这期间点刷新会立即重试，若未生效再点一次。
  - `ai-studio`：AI Studio 不提供剩余总额度，卡片会展示当前账号正在冷却的模型、恢复时间或重新登录提示。

---

## 图片生成（AI Studio）

`ai-studio` 会列出账号可用的 Nano Banana 系列图像模型（如 `gemini-3.1-flash-image`、`gemini-3-pro-image`），供 Magpie 的图片生成使用。**需要 Magpie v0.1.2075 及以上**：从这个版本起，Magpie 才会把插件的 Gemini 图像模型列为出图模型。

**让 Agent 出图**（pi、Claude Code、Codex 等都一样）：

1. **选画图模型**：Magpie 设置的 **Images → Image generation** 会直接列出这些模型，选中一个（如 `ai-studio/gemini-nano-banana-2.1`），或保持 Automatic（自动）。不用在模型列表里勾选它们。
2. **把画图工具交给 Agent**：点这一行下面的 **Give agents Magpie Image…**，在打开的 Library 里勾选要出图的 Agent，然后新开一个 Agent 会话。Library 被关掉时，这里显示的是 **Turn on the Library**，先点它。也可以用命令行：`magpie library mcp add magpie-image magpie mcp image agents=pi`（多个 Agent 用逗号隔开，如 `agents=pi,claude`）。
3. **照常对话**：Agent 继续用平常的对话模型，跟它说「画一张……」就行。它会调用 `generate_image` 工具，用第 1 步选的模型出图，图片存进项目的 `generated-images/` 文件夹；带参考图就是改图。

- **别把图像模型选成对话模型**：Magpie 目前会把能出图的插件模型也留在对话模型列表里（[yetone/magpie#2792](https://github.com/yetone/magpie/issues/2792)）。选了也看不到图：pi 等 Agent 的回复里放不下图片，模型画出的图会被直接丢掉，模型却以为已经发出去了。它们也不支持工具调用，上下文只有 32K–128K。
- **在命令行出图**：`magpie tool generate_image "a magpie on a branch, watercolour" --size 16:9 -o magpie.png`，加 `--model ai-studio/gemini-3-pro-image` 可以临时换模型。终端里找不到 `magpie` 命令时（第 2 步的命令也一样），在 Magpie 设置的 **Command line** 一行点 **Add to PATH**，再开一个新终端。
- **尺寸**：`size` 决定宽高比：写比例（如 `16:9`、`1:4`）时，模型支持就照用，不支持就取它支持的最接近的比例；写 `1536x1024` 这样的尺寸时，Magpie 先换成最接近的常用比例。`quality` 对这些模型不起作用。
- 不需要图像模型时，可以用 `studio.imageModels` 关掉（见下方选项）。

---

## 配置与进阶

<details>
<summary><b>⚙️ 插件选项与代理配置</b>（开启图片输入、设置代理、连接自建后端）</summary>

<br>

工具调用与图片输入默认开启。可通过命令行修改插件配置：

```bash
# 仅关闭 Gemini Web 的图片输入，保留 AI Studio 的图片输入
magpie plugin options magpie-gemini-web '{"allowImages":false,"studio":{"allowImages":true}}'

# 关闭 AI Studio 的图片输入
magpie plugin options magpie-gemini-web '{"studio":{"allowImages":false}}'

# 为 AI Studio 配置代理
magpie plugin options magpie-gemini-web '{"studio":{"proxy":"http://127.0.0.1:7890"}}'
```

> **Windows PowerShell**：`magpie` 实际运行的是 `magpie.cmd` 包装器，它转发参数时会弄丢 JSON 里的双引号。请直接调用它背后的可执行文件：这个文件和 `magpie.cmd` 在同一个文件夹（`where.exe magpie` 可以找到），文件名可能是 `magpie-windows-amd64.exe` 之类，Magpie 的「设置 → 命令行」里也会显示。写法取决于 PowerShell 版本（用 `$PSVersionTable.PSVersion` 查看）：
> - PowerShell 7.3 及以上，默认设置：`& "<可执行文件的完整路径>" plugin options magpie-gemini-web '{"allowImages":true}'`
> - Windows PowerShell 5.1（系统自带）：它不会替你转义参数里的双引号，要写成 `\"`：`& "<可执行文件的完整路径>" plugin options magpie-gemini-web '{\"allowImages\":true}'`

| 选项 | 默认值 | 适用范围 | 说明 |
| :--- | :--- | :--- | :--- |
| `allowTools` | `true` | 共用（可用 `studio.allowTools` 单独覆盖） | 允许工具调用。设为 `false` 时带工具的请求返回 400 |
| `allowImages` | `true` | 共用（可用 `studio.allowImages` 单独覆盖） | 允许对话中的图片输入（图像模型的参考图不受它限制）。Gemini Web 读图需要登录，未登录时返回 400 |
| `requestTimeoutMs` / `modelTimeoutMs` | Web：`570000` / `10000`；Studio：`1800000` / `10000` | 共用（`studio.*` 可覆盖） | 单次等待后端 / 拉取模型列表的超时（毫秒）；收到流数据后重新计时，显式配置优先 |
| `stripCitations` | `true` | 仅 `gemini-web` | 剥离回复与工具参数中的 `[cite: 1]`、`[cite_start]` 标记（AI Studio 不支持剥离） |
| `proxy` | 无 | 仅 `gemini-web` | 一键配置后端访问 Google 的代理（`http` / `https` / `socks5` / `socks5h`），也可用环境变量 `GEMINI_WEB_PROXY` 或在登录第一步填写 |
| `baseURL` | `http://127.0.0.1:8083/v1` | 仅 `gemini-web` | Gemini Web 默认后端地址 |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | 仅 `gemini-web` | 向客户端声明的上下文 / 输出上限 |
| `studio.proxy` | 无 | 仅 `ai-studio` | 访问 Google 的代理（`http` / `https` / `socks5`），也可用环境变量 `AI_STUDIO_PROXY`；设置后优先于管理页里保存的代理，留空等于不设置 |
| `studio.accountOrder` | 无 | 仅 `ai-studio` | 账号优先顺序（逗号分隔字符串或字符串数组，如 `["b@gmail.com","a@gmail.com"]`）；当 `.env` 中未保存或为空时作为初始值写入，管理页保存非空值后优先保留管理页设置 |
| `studio.modelAccounts` | 无 | 仅 `ai-studio` | 模型专属账号绑定（`"model:acc1|acc2"` 字符串或 `{ "gemini-3.1-pro-preview": ["acc1", "acc2"] }` 对象）；当 `.env` 中未保存或为空时作为初始值写入，管理页保存非空值后优先保留管理页设置 |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | 仅 `ai-studio` | 连接已有 AIStudio2API 时的默认地址 |
| `studio.contextLimit` / `studio.outputLimit` | 模型目录默认值 | 仅 `ai-studio` | 向客户端声明的上限（仅支持在目录值基础上调低） |
| `studio.imageModels` | `true` | 仅 `ai-studio` | 列出 Nano Banana 等图像模型，供 Magpie 的图片生成使用；设为 `false` 时只列文本模型 |

**配置代理访问 Google：**
- **AI Studio**：推荐在本地管理页设置。在 Magpie 中选「添加账号并连接（推荐）」并选择添加新账号，从连接页打开已认证的账号管理页；保存代理后在管理页重启服务即可生效，之后插件重启后端也不会覆盖它。额度卡片显示管理页地址，不再展示管理员信息、凭据文件位置或本地程序路径。
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
<summary><b>🛠️ AI Studio 命令行工具</b>（查看状态、预下载浏览器、版本管理）</summary>

<br>

**本地服务什么时候启动、停止：**
- 插件加载时（例如打开 Magpie）会在后台启动本地服务；之后发请求、刷新额度卡片时，服务没在运行也会自动启动。
- 本地服务是独立进程，**退出 Magpie 不会停止它**，下次打开 Magpie 直接接着用。
- 停止服务用下表的 `studio:stop`（或报错里给出的完整命令）。停止只是一次性的：下一次请求会再次启动它。

当插件报错提示运行命令时，直接复制报错中的完整命令执行即可。在插件目录下也可使用：

| 命令 | 作用 |
| :--- | :--- |
| `npm run studio:status` | 查看本地服务与账号状态 |
| `npm run studio:start` / `studio:stop` | 启动 / 停止本地服务 |
| `npm run studio:clean` | 清理默认目录下载的后端与 Camoufox，保留账号和配置；自备路径跳过清理 |
| `npm run studio:use -- <程序路径>` | 选择自备 AIStudio2API，可使用官方或自定义版本；切换前须停止服务 |
| `npm run studio:use-default` | 切回默认安装目录；已有程序继续复用，缺失时自动安装官方版 |
| `npm run studio:login` | 添加 Google 账号 |
| `npm run studio:prepare-browser` | 先下载登录浏览器，准备完成后再在 Magpie 发起登录；关闭命令不会取消后台下载 |
| `npm run studio:relogin -- [<账号>]` | 重新登录过期账号（仅一个账号时可省略参数） |
| `npm run studio:install -- [--version v0.3.7]` | 停止服务后安装官方最新版或指定版本，保留账号与配置 |
| `npm run studio:install -- --version v0.3.7 --archive <文件>` | 从本地官方包安装，仍从 GitHub 查询该版本的校验值 |
| `npm run studio:official:smoke` | 在临时目录验证官方安装、账号目录、连接及运行中替换，不使用真实 Google 凭据 |
| `npm run studio:updates -- auto` / `manual` | 开启或关闭默认官方后端的自动更新；不带参数查看策略 |
| `npm run studio:auto-update:smoke` | 在临时目录验证后台自动升级、保留数据和启动失败后的程序回滚 |
| `npm run studio:update:smoke -- v0.3.6` | 在临时目录将旧官方版实际在线升级到最新版，验证进程与重启 |
| `node scripts/studio.mjs import <目录>` | 在服务停止状态下导入已有账号 |
| `npm run studio:smoke` | 发起真实请求验收（会消耗账号额度） |

</details>

<details>
<summary><b>🔒 安全、数据目录与后端版本管理</b>（日志位置、升级与回退）</summary>

<br>

**安全与数据目录：**
- 两个后端均只监听 `127.0.0.1`，Cookie 与登录态仅保存在本机，Magpie 仅保存本地生成的随机 API Key。
- **Gemini Web 数据目录**：`~/.local/share/magpie-gemini-web`（可通过 `GEMINI_WEB_DATA_DIR` 修改），日志位于 `backend.log`。支持 macOS、Linux、Windows（x64 / arm64）。
- **AI Studio 数据目录**：`~/.local/share/magpie-ai-studio`（可通过 `AI_STUDIO_DATA_DIR` 修改），日志位于 `backend.log`（超 10 MB 下次启动自动轮转）。默认使用 2048 端口，被占用时自动顺延并记录在 `config.json`。支持 macOS、Linux（x64 / arm64）与 Windows x64。
- **卸载与清理下载资产**：在 Magpie 中删除插件（或运行 `npm run studio:clean`、`npm run backend:clean`）会停止插件托管的本地服务并删除其已下载二进制及安装包。**自备 AIStudio2API 模式会保留该后端进程、程序及整个数据目录**，由用户自行停止和清理。
  - 清理会保留 `auth/`、`gemini.db`、`config.json`、`.env` 与 `secrets.json`，以便重装插件或下次发起请求时自动按需重装后端、免去重新登录或导 Cookie；若要彻底停用自动重装，请在 Magpie 中删除对应登录卡片或一并删除数据目录中的配置文件。
  - 默认数据目录按当前系统用户共享；若在同一账号下隔离运行多个 Magpie 配置目录，请分别设置 `AI_STUDIO_DATA_DIR` 与 `GEMINI_WEB_DATA_DIR`，避免卸载其一时清理共享资产。
- Gemini Web 每个登录同时最多 2 个请求（AI Studio 为 1），可在 Magpie 的 provider 设置里调整。这是 Magpie 每张卡片的并发限制，后端 Worker 数由上述迁移规则或管理页设置决定；仍无法完全排除 Google 账号风控风险，请自行评估使用。

**AI Studio 升级与模型范围：**
- 安装和自动更新来自官方最新稳定版，支持 macOS / Linux x64、arm64 与 Windows x64。读取官方发布元数据，只接受对应平台的安装包及 SHA-256；插件发布不依赖定制后端构建或固定发行哈希。
- 连接 0.3.7 时，`MAX_ACCOUNT_SWITCHES`、`DISCOVER_HIDDEN_MODELS`、账号顺序、模型账号绑定及其他合法 `.env` 键会保留。已有显式设置继续生效，未设置项使用后端默认值；插件不再补入固定的并发、备用请求或生成后端设置。
- 默认程序为数据目录中的 `package/aistudio2api`，Windows 为根部的 `aistudio2api.exe`。旧托管构建的账号和数据继续保留，自动更新可将其替换为官方包。历史构建和 0.3.7 候选补丁保留在 [docs/studio-release.md](docs/studio-release.md)，不参与默认安装和更新决策。
- 停止时会发现更新后的 PID 并核对程序身份；自备路径还核对账号目录参数，以区分共用同一程序的实例。无法核实身份就不会发送终止信号；HTTP 已关闭但仍有进程运行时，禁止安装替换或重复启动。
- 默认目录缺少程序时自动安装；已有程序在后台按空闲状态更新。自备路径缺失时明确报错。程序回滚不会撤销后端自身的数据迁移；手动降级前应备份整个数据目录，包括 `auth/`、`runtime/requests.db` 等。
- 插件默认单次响应等待／流空闲超时为 30 分钟，可用 `studio.requestTimeoutMs` 调整；后端的请求期限与并发数由其默认值或管理页设置决定。较短期限可能中断长回复，上游自动续写期限按所选版本的规则计算。
- 已核对本机 Magpie `v0.1.1285`（`d783df46`）源码：插件请求走 `Provider.Do → plugin.Fetch → loader.fetch`，绕过普通 HTTP transport 的 10 分钟响应头限制；此插件生成路径没有发现更短的固定总超时。网关 5 分钟 `IdleTimeout` 仅针对请求之间的空闲连接。客户端或反向代理仍可设置更短期限；这不是一次实等 30 分钟的端到端验证。
- 支持 Deep Research 模型（`deep-research-preview-04-2026`、`deep-research-max-preview-04-2026`）：需要登录 Google AI Pro / Ultra 账号才会在列表中出现；由后端将异步 Interactions 任务适配到 `/v1/chat/completions` 流式返回（含思考过程与服务端内置联网搜索），不支持客户端 `tool_call`（Function Calling）或 `temperature`。
- 模型列表过滤 `-build` / `assistant_route` 模型：这类模型附带 Build 写代码助手的系统提示词，不作为普通 Agent 模型提供。升级后可执行 `magpie provider models ai-studio` 刷新列表。

**Gemini Web 优化后端升级与回退：**
- [#53](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/53) 的多账号索引漏传已修复，需重新导入受影响的 Cookie 或在后端账号管理中修正索引。账号检测通过不保证生成成功；登录态 Argon 挂起仍待验证修复。当前优化版仍使用 StreamGenerate，启用 `web_channel` 会在日志提示被忽略。
- 插件默认使用本仓库发布的 [4.28.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.28.0-magpie.1)（基于上游 v4.28.0 集成 XSRF 缓存、请求取消传播、工具调用提前收尾与 Argon 校验补丁）。对话请求按上游沉默计时：Google 让请求排队时每 60 秒发一次心跳，后端会一直等到出字；连续 `request_timeout_sec`（默认 180 秒）没有任何数据才放弃这一次并重试，还在出字的长回复也不会被截断。
- **旧版升级**：插件不会打断运行中的后端。先停止旧进程（PID 见数据目录 `backend.pid`），下次启动 Magpie 或发请求时会自动更新二进制并保留原有配置与账号。
- **回退官方版 / 恢复优化版**（停止后端后在插件目录执行）：
  ```bash
  npm run backend:install:upstream  # 回退并固定使用官方 v4.28.0
  npm run backend:install           # 恢复默认优化版
  ```
- 源码复现构建与发布流程见 [docs/backend-release.md](docs/backend-release.md)。

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

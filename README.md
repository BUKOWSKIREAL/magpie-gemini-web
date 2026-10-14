# magpie-gemini-web

中文 | [English](README.en.md)

让 [Magpie](https://usemagpie.ai/) 通过你的 Google 账号使用 Gemini 网页版。插件在本机运行 [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) 后端，把 Gemini 网页转成 OpenAI 兼容接口。

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

工具调用和图片输入默认关闭，Coding Agent 需要工具时请开启：

```bash
magpie plugin options magpie-gemini-web '{"allowTools":true,"allowImages":true}'
```

| 选项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `allowTools` | `false` | 允许工具调用（实验性）。关闭时带工具的请求会返回 400 |
| `allowImages` | `false` | 允许图片输入 |
| `baseURL` | `http://127.0.0.1:8083/v1` | 默认后端地址 |
| `contextLimit` / `outputLimit` | `32768` / `8192` | 向客户端声明的上下文 / 输出上限 |
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | 请求 / 拉取模型列表的超时（毫秒） |

## 思考档位

有 `-thinking` 版本的模型可以在 Magpie 里切换 `low` / `high`：`low` 用普通模型，`high` 用 `-thinking` 模型（扩展思考）。升级插件后执行 `magpie provider models gemini-web` 刷新模型列表。Argon 的「中」档等上游支持（[#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)）。

## 安全与数据

- 后端只监听 `127.0.0.1`；Cookie 只交给本机后端，Magpie 保存的是本地生成的 API key。
- 后端二进制锁定官方 v4.22.0，下载和每次启动都校验 SHA-256。支持 macOS、Linux、Windows（x64 / arm64）。
- 数据目录：`~/.local/share/magpie-gemini-web`（可用 `GEMINI_WEB_DATA_DIR` 修改），日志在 `backend.log`。
- 插件限制并发为 1，但无法保证账号不被 Google 风控，请自行承担风险。

## 局限

- 工具调用由上游用提示词模拟，不一定可靠，Flash 系列经常不调用工具。
- 只开放 `gemini-` 开头的文本模型；`cost` 显示为 0 不代表 Google 的实际配额。

## Argon 增强版（可选）

官方后端已支持 `gemini-4-argon`（需付费 / Ultra 账号）。本仓库的补丁版额外校验返回的确实是 Argon（防止被静默降级），并降低延迟。需要 Go 1.26+：

```bash
git clone https://github.com/BUKOWSKIREAL/magpie-gemini-web.git && cd magpie-gemini-web
git clone https://github.com/zexadev/gemini-web2api-go.git backend-source
git -C backend-source checkout a65b1d1a5ac614c1b455857334b4f1c73ab8fcfb
git -C backend-source apply ../patches/argon.patch
npm run backend:build:argon
npm run backend:install:argon
```

安装后重启 Magpie 即可，插件会在后台启动 Argon 版（如有旧后端在运行，先 `kill $(cat ~/.local/share/magpie-gemini-web/backend.pid)`）。运行 `npm run backend:install` 可切回官方版。

## 许可证

MIT。上游 gemini-web2api-go 同为 MIT（见 `LICENSE-UPSTREAM`）。

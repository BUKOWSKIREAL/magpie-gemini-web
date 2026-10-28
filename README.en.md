# <img src="docs/logo.svg" width="28" height="28" align="top" alt="" /> magpie-gemini-web

[![npm version](https://img.shields.io/npm/v/magpie-gemini-web?style=flat-square&logo=npm&color=4f46e5)](https://www.npmjs.com/package/magpie-gemini-web) [![npm downloads](https://img.shields.io/npm/dw/magpie-gemini-web?style=flat-square&color=06b6d4)](https://www.npmjs.com/package/magpie-gemini-web) [![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-3b82f6?style=flat-square)](https://usemagpie.ai/) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-8b5cf6?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/) [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6366f1?style=flat-square)](https://github.com/BUKOWSKIREAL/magpie-gemini-web) [![License: MIT](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](LICENSE)

[中文](README.md) | English

Use **Google AI Studio** and **Gemini on the web** through your Google account in [Magpie](https://usemagpie.ai/). The plugin runs [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) and [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) locally, turning Google web interfaces into OpenAI-compatible APIs.

> **2026-10-16 update:** Full-price Google AI Pro accounts can now use `gemini-4-argon` directly in Antigravity, and can likewise be proxied directly with Magpie.

## Which Provider Should I Choose?

The plugin provides two independent providers that can be used individually or together:

| Feature | Google AI Studio (`ai-studio`) | Gemini Web (`gemini-web`) |
| :--- | :--- | :--- |
| **Best for** | **Coding agents (recommended)** | General chat, web-only models & web quota |
| **Tool calling** | **Native Function Calling**, reliable | Prompt-emulated (experimental; Flash often skips tools) |
| **Thinking levels** | `minimal` / `low` / `medium` / `high` (`minimal` is fastest & cheapest) | `low` (base) / `medium` (`-thinking-medium`, `gemini-4-argon` only) / `high` (`-thinking` extended thinking) |
| **Sign-in method** | Sign in directly in an isolated popup browser window | Copy `cookie` from a private/incognito window |
| **Usage cards** | Shows models currently on cooldown and recovery times | Syncs **5-hour** & **weekly** usage and reset times from the web |
| **Local backend** | AIStudio2API (`v0.2.16`) | gemini-web2api-go (`4.26.0-magpie.1` optimized build) |

---

## Quick Start

Install **magpie-gemini-web** from the Magpie plugin market, then sign in to either (or both) providers below. The plugin automatically downloads the corresponding backend, verifies its SHA-256 checksum, and runs it in the background—no Go installation or extra setup required.

### Option 1: Google AI Studio (`ai-studio`)

1. Sign in to **Google AI Studio** in Magpie and choose **「用 Google 账号登录（推荐）」** (Sign in with a Google account).
2. Sign in to your Google account in the separate login window that opens (your regular browser is unaffected), then close the window.
   > On first run, the local service (~25 MB) and the login browser Camoufox (~300 MB) are downloaded first, so the window may take a few minutes to appear. While they download, Magpie opens a progress page in your browser. Magpie waits at most 10 minutes, downloads included, so finish signing in promptly; if GitHub is unreachable, set `studio.proxy` first (see plugin options and proxy settings below).
3. **Managing accounts:** Choose "Sign in with a Google account" again at any time to **add a new account**, create a card for an existing local account, or **re-authenticate** an expired account.

### Option 2: Gemini Web (`gemini-web`)

1. Sign in to **Gemini Web** in Magpie and choose **「一键配置本地 Gemini Web（推荐）」** (One-click local setup). If you need a proxy to reach Google, enter its URL (e.g. `http://127.0.0.1:7890`) when prompted at the start of sign-in, or leave it blank for direct connection / existing proxy pool.
2. Copy your cookie using a **private / incognito window** (Firefox recommended):
   1. Open <https://gemini.google.com/app> in the private window and sign in to your Google account.
   2. Press `F12` (`⌥⌘I` on macOS), switch to the **Network** tab, and reload the page.
   3. Click any `gemini.google.com` request → **Headers** → **Request Headers**, copy the `cookie` value, and paste it into Magpie.
   4. **Close the private window directly—do not sign out** (signing out invalidates the cookie).
3. The plugin verifies the account and completes sign-in. Repeat the steps above to add more accounts.

> **Backend upgrade required during sign-in?** An older background process may still be running. Exit Magpie, stop the matching `gemini-web2api-go` process (Windows: Task Manager → Details → `gemini-web2api-go.exe`), then run the full installation command shown in the error. It preserves accounts and configuration and selects the plugin's managed backend. Set `GEMINI_WEB_PROXY` first if the download needs a proxy. Reopen Magpie and sign in after installation.

> **Why is a private window required?** The backend periodically refreshes this session to keep it alive. If it shares a session with your daily browser, Google will revoke the session and sign your browser out of all Google services. A private window (or a dedicated secondary Google account) gives the backend an isolated session.

---

## Multiple Accounts & Usage Cards

- **One card per account:** Each Google account gets its own usage card titled with its email address.
  - *Migrating older Gemini Web accounts:* For accounts added in earlier versions, add a Gemini Web account in Magpie and choose **「添加本地后端里已有的 Google 账号」** (Add an existing Google account from the local backend) to create individual cards, then remove the old pooled `API key …` card.
- **Automatic account rotation:** The local backend selects which Google account serves each request (Gemini Web rotates across the pool; AI Studio uses one account until cooldown and switches to the next). Switching cards in Magpie does not change which account the backend picks.
- **Usage reporting:**
  - `gemini-web`: Available only with the one-click local backend. To minimize requests to Google, usage is refreshed only after an account is used or a quota window resets (at least 10 minutes apart, and at most once every 6 hours when idle).
  - `ai-studio`: AI Studio does not report remaining total quota; cards display models currently on cooldown and their recovery times, or prompt when re-authentication is needed.

---

## Configuration & Advanced Usage

<details>
<summary><b>⚙️ Plugin Options & Proxy Setup</b> (image input, proxy configuration, custom backends)</summary>

<br>

Tool calling is enabled by default; image input is disabled by default. Configure plugin options via the CLI:

```bash
# Enable image input (applies to both providers)
magpie plugin options magpie-gemini-web '{"allowImages":true}'

# Configure a proxy for AI Studio
magpie plugin options magpie-gemini-web '{"studio":{"proxy":"http://127.0.0.1:7890"}}'
```

> **Windows PowerShell**: `magpie` runs the `magpie.cmd` wrapper, which loses the double quotes inside the JSON when it passes the arguments on. Call the program behind it directly instead: it is in the same folder as `magpie.cmd` (which `where.exe magpie` finds), named something like `magpie-windows-amd64.exe`, and Magpie's Settings > Command line shows it too. How to write it depends on the PowerShell version (`$PSVersionTable.PSVersion` shows it):
> - PowerShell 7.3 or later, default settings: `& "<full path to the program>" plugin options magpie-gemini-web '{"allowImages":true}'`
> - Windows PowerShell 5.1 (built into Windows): it doesn't escape the double quotes in an argument for you, so write them as `\"`: `& "<full path to the program>" plugin options magpie-gemini-web '{\"allowImages\":true}'`

| Option | Default | Scope | Description |
| :--- | :--- | :--- | :--- |
| `allowTools` | `true` | Shared (override via `studio.allowTools`) | Allow tool calls. When `false`, requests with tools return 400 |
| `allowImages` | `false` | Shared (override via `studio.allowImages`) | Allow image input |
| `requestTimeoutMs` / `modelTimeoutMs` | Web: `240000` / `10000`; Studio: `1800000` / `10000` | Shared (override via `studio.*`) | Timeout (ms) per backend wait or model list fetch; resets on stream data, explicit settings take precedence |
| `stripCitations` | `true` | `gemini-web` only | Strip `[cite: 1]` and `[cite_start]` markers from replies and tool arguments (not supported on AI Studio) |
| `proxy` | none | `gemini-web` only | Proxy for the managed Gemini Web backend to reach Google (`http` / `https` / `socks5` / `socks5h`), or set `GEMINI_WEB_PROXY` env var / enter during sign-in |
| `baseURL` | `http://127.0.0.1:8083/v1` | `gemini-web` only | Default Gemini Web backend URL |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | `gemini-web` only | Context and output limits reported to clients |
| `studio.proxy` | none | `ai-studio` only | Proxy for reaching Google (`http` / `https` / `socks5`), or set `AI_STUDIO_PROXY` env var; when set, it takes precedence over the proxy saved in the admin page. An empty value counts as unset |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | `ai-studio` only | Default URL when connecting an existing AIStudio2API instance |
| `studio.contextLimit` / `studio.outputLimit` | Model catalog defaults | `ai-studio` only | Limits reported to clients (can only lower the catalog defaults) |

**Using a proxy to reach Google:**
- **AI Studio:** Preferably set it in the local admin page. Open the address on the usage card's "管理页" (admin page) line (default `http://127.0.0.1:2048`) and sign in as `magpie` with `adminPassword` from `config.json` in the data directory. Save the proxy, then restart the service from the admin page. The plugin keeps the saved value when it restarts the backend.
  - Alternatively, `studio.proxy` or `AI_STUDIO_PROXY` take precedence over the saved proxy. A change applies after the local service restarts (`npm run studio:stop`; the next request starts it again).
  - With none set, the backend goes out directly, or on Windows through the system proxy (Windows proxy settings).
  - **The backend uses neither Magpie's proxies (including the provider proxy set for `ai-studio`) nor `HTTPS_PROXY` and similar variables**: it keeps running after Magpie quits, when a proxy borrowed from Magpie may be gone. Use one of the options above. A backend started by a plugin version from before this fix may still be using a proxy from the environment it was started in (Magpie's, for example); the "代理出口" line marks it and says what a restart changes.
  - The usage card's "代理出口" (proxy) line, the Google sign-in instructions and failure messages, and `npm run studio:status` show the proxy the backend actually uses, where it comes from, and whether a new setting still needs a restart.
  - The listen address, API key and admin credentials are managed by the plugin; changing them in the admin page has no effect.
- **Gemini Web:** The backend ignores system proxies and `HTTP_PROXY`. Enter your proxy URL when prompted at the start of "One-click local setup", set the `proxy` plugin option or `GEMINI_WEB_PROXY` environment variable, or add it to the proxy pool in the local admin panel at `http://127.0.0.1:8083/admin` (password is `adminToken` in `secrets.json` inside the data directory).
  - *Note:* When using a proxy pool, send one request with a newly added account so the backend binds it to a proxy, then re-add it via "Add an existing Google account from the local backend" to load its email and usage (SOCKS proxies are not supported for usage reads).

**Connecting a self-hosted backend:**
If you already run `gemini-web2api-go` or `AIStudio2API` yourself, select **Connect an existing backend / AIStudio2API** during sign-in and provide its `/v1` URL and API key.

**Refreshing the model list:**
After upgrading the plugin, run `magpie provider models gemini-web` to refresh available models.

</details>

<details>
<summary><b>🛠️ AI Studio CLI Commands</b> (service status, re-login, offline install)</summary>

<br>

**When the local service starts and stops:**
- It starts in the background when the plugin loads (when Magpie opens, for example); after that, a request or a usage card refresh starts it again if it isn't running.
- It is a process of its own: **quitting Magpie doesn't stop it**, and Magpie picks it up again the next time it opens.
- To stop it, use `studio:stop` below (or the full command the card or an error gives). A stop lasts until the next request, which starts it again.

When a plugin error asks you to run a command, it includes the full ready-to-copy path. From the plugin directory, you can also run:

| Command | Description |
| :--- | :--- |
| `npm run studio:status` | Show local service and account status |
| `npm run studio:start` / `studio:stop` | Start / stop the local service |
| `npm run studio:login` | Add a Google account |
| `npm run studio:relogin -- [<account>]` | Re-authenticate an expired account (argument optional if only one) |
| `npm run studio:install -- --archive <file>` | Offline install from a pre-downloaded archive |
| `node scripts/studio.mjs import <dir>` | Import existing accounts while the service is stopped |
| `npm run studio:smoke` | Run a live acceptance check (consumes account quota) |

</details>

<details>
<summary><b>🔒 Security, Data Directories & Backend Version Management</b> (logs, rollback, macOS Native Task)</summary>

<br>

**Security & data directories:**
- Both backends listen on `127.0.0.1` only. Cookies and sessions remain on your machine; Magpie stores only a locally generated API key.
- **Gemini Web data directory:** `~/.local/share/magpie-gemini-web` (override with `GEMINI_WEB_DATA_DIR`), logs at `backend.log`. Supports macOS, Linux, and Windows (x64 / arm64).
- **AI Studio data directory:** `~/.local/share/magpie-ai-studio` (override with `AI_STUDIO_DATA_DIR`), logs at `backend.log` (rotated on next start after exceeding 10 MB). Uses port 2048 by default (or picks a free port and saves it in `config.json`). Supports macOS, Linux (x64 / arm64), and Windows x64.
- Concurrency is capped at 1, but Google account rate-limiting or flagging cannot be completely ruled out—use at your own risk.

**AI Studio upgrades and model selection:**
- The plugin pins SHA-256-verified `v0.2.16-magpie.1`, based on upstream `v0.2.16`. Upgrade the plugin to update the backend. Official releases at or below that upstream version, and managed backends an older plugin installed, are upgraded on the next managed startup, preserving accounts, port and sign-in credentials.
- **Online updates are disabled in the managed backend on macOS, Linux, and Windows.** The admin page says updates are managed by magpie-gemini-web; the update endpoint returns HTTP 409 and update checks do not contact GitHub. Independently managed external servers are unaffected. See [docs/studio-release.md](docs/studio-release.md) for how the managed build is made and reproduced.
- Managed Unix installs still attempt to set `package/` to `0555` as additional file protection. Permission failures do not block service, and disabling online updates does not depend on permissions. To reset by manually deleting the data directory, stop the service first, then run `chmod -R u+w "<data-dir>/package"` before deleting it; replace `<data-dir>` with the actual path.
- If a newer or custom version is installed, the plugin reports a conflict with `stop`, `install`, and `start` commands carrying the correct `--data-dir`. Stop can recover a changed listener PID and verifies its executable path before signaling it. If HTTP is down but the process is still alive, the plugin refuses to reinstall or launch a second process.
- When stopped, a replaced executable is restored from the verified pinned archive; failed verification never launches the replacement. Existing account and runtime data files are kept, but **an older backend may not read data migrated by a newer version**. Before manually downgrading, stop the service and back up the entire data directory, including `auth/` and `runtime/requests.db`. If data migration is known to have occurred, update the plugin to match the newer backend.
- The backend's base request deadline and the plugin's default response/stream-idle timeout are 30 minutes (override via `studio.requestTimeoutMs`). This allows long non-streaming replies to finish collecting on the server. A stalled backend can also take 30 minutes to time out, and its single worker can hold up later requests. Cancel a request or choose a shorter timeout when needed; shorter limits can interrupt valid long replies. Upstream controls deadline scaling for automatic continuation.
- Source review of the locally installed Magpie `v0.1.1285` (`d783df46`) found no shorter fixed total timeout on this plugin's generation path: `Provider.Do → plugin.Fetch → loader.fetch` bypasses the ordinary HTTP transport's 10-minute response-header timeout. The gateway's 5-minute `IdleTimeout` applies between requests. Clients or reverse proxies can impose shorter limits; this was not a 30-minute end-to-end waiting test.
- Models with `-build` or `assistant_route` are filtered out: they inject the Build coding assistant's own system prompt and are not offered as ordinary Agent models. Refresh with `magpie provider models ai-studio` after upgrading.

**Gemini Web optimized backend upgrades & rollback:**
- One-click setup uses [4.26.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.26.0-magpie.1) by default (built from pinned upstream v4.26.0 with XSRF caching, request cancellation propagation, early tool-call completion, and Argon model verification).
- **Upgrading:** Running backends are not interrupted automatically. Stop the existing process (PID in `backend.pid` inside the data directory); the next Magpie launch or request will upgrade the binary while preserving config and cookies.
- **Rollback to upstream / restore optimized build** (run in the plugin directory after stopping the backend):
  ```bash
  npm run backend:install:upstream  # Roll back and pin to official v4.26.0
  npm run backend:install           # Restore default optimized build
  ```
- For reproducible builds and release procedures, see [docs/backend-release.md](docs/backend-release.md).

**Native Task on macOS (experimental):**
On macOS, Gemini Web sign-in includes an experimental **macOS Native Task** option that routes requests through `Gemini.app`'s native Task mode (`gemini-task-argon` with native Function Calling). Currently in Alpha and requires local setup first—see [native-task/README.md](native-task/README.md).

</details>

---

## License

MIT. The upstream `gemini-web2api-go` project is also MIT (see `LICENSE-UPSTREAM`).

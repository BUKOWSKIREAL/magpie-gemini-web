# magpie-gemini-web

[中文](README.md) | English

Use Gemini on the web and Google AI Studio through your Google account in [Magpie](https://usemagpie.ai/). The plugin runs [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) and [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) backends on your machine, turning Google web interfaces into OpenAI-compatible APIs.

The plugin provides two independent providers:
- `gemini-web`: the Gemini web app; see [Getting started](#getting-started-gemini-web).
- `ai-studio`: Google AI Studio, with native tool calling; see [Google AI Studio](#google-ai-studio-ai-studio).

> **2026-10-16 update:** Full-price Google AI Pro accounts can now use `gemini-4-argon` directly in Antigravity, and can likewise be proxied directly with Magpie.

## Getting started (Gemini Web)

1. Install **magpie-gemini-web** from the Magpie plugin market.
2. Sign in to Gemini Web and choose **一键配置本地 Gemini Web (one-click local setup, recommended)**. The plugin downloads this project's optimized backend, verifies its SHA-256 and starts it in the background. No Go installation or manual patching is needed.
3. Copy your cookie when prompted. **Use a private / incognito window** (Firefox recommended):
   1. In the private window, open <https://gemini.google.com/app> and sign in to the Google account you want to use.
   2. Press F12 (⌥⌘I on macOS), switch to **Network** and reload the page.
   3. Click any `gemini.google.com` request and go to **Headers** → **Request Headers**.
   4. Copy the value of the `cookie` line and paste it into Magpie.
   5. Close the private window. **Don't sign out**, because signing out invalidates the cookie.
4. The plugin checks that the account works, then finishes signing in.

> **Why a private window?** The backend refreshes this sign-in periodically to keep it alive. If it shares a session with the browser you normally use, Google revokes the session and your browser gets signed out of every Google service. A private window gives the backend a session of its own. Using a separate Google account for the backend is safer still.

From then on, Magpie starts the backend automatically every time it launches. To add another account, run the one-click setup again.

> Need a proxy to reach Google? The backend ignores `HTTP_PROXY`. Add the proxy in the proxy pool of the admin panel at `http://127.0.0.1:8083/admin`. The admin password is `adminToken` in `secrets.json` in the data directory.

**Connecting an existing backend:** if you already run gemini-web2api-go yourself, choose 连接已有后端 (connect an existing backend with a custom URL and API key). Enter its URL (ending in `/v1`) and its `API_KEY`.

## Plugin options (Gemini Web)

Tool calls are on by default (coding agents send tools with every request); image input is off. To allow images:

```bash
magpie plugin options magpie-gemini-web '{"allowImages":true}'
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `allowTools` | `true` | Allows tool calls (experimental; upstream emulates them with prompts). When `false`, requests with tools get a 400 |
| `allowImages` | `false` | Allows image input |
| `baseURL` | `http://127.0.0.1:8083/v1` | Default backend URL |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | Context and output limits reported to clients |
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | Timeouts in ms for requests and for fetching the model list. The request timeout counts each wait on the backend, so a reply that keeps coming is never cut off |
| `stripCitations` | `true` | Removes the citation markers Gemini adds to replies, `[cite: 1]` and `[cite_start]`, tool call arguments included. Set it to `false` while Gemini edits code that contains such text itself |

## Thinking effort

You can switch a model between `low` and `high` effort in Magpie if it has a `-thinking` version. `low` uses the base model and `high` uses the `-thinking` model with extended thinking, so the `-thinking` model isn't listed on its own. After upgrading the plugin, run `magpie provider models gemini-web` to refresh the model list. Argon's medium tier will be added once upstream supports it ([#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)).

## Security and data

- The backend listens on `127.0.0.1` only. Your cookie goes only to that local backend, and Magpie stores a locally generated API key instead.
- The default backend is this project's **4.22.0-magpie.1**, built from pinned upstream v4.22.0 sources with this repository's patch. SHA-256 is checked on download and before launching a new process. Builds cover macOS, Linux and Windows on x64 and arm64; the release includes sources, build metadata and checksums.
- The data directory is `~/.local/share/magpie-gemini-web` (set `GEMINI_WEB_DATA_DIR` to change it). The backend writes its log to `backend.log` there.
- The plugin sends one request at a time, but this can't guarantee that Google won't flag your account. Use it at your own risk.

## Usage

Magpie's usage cards show each Google account's **5-hour** and **weekly** usage and reset times, as <https://gemini.google.com/usage> does. Each Google account gets a card of its own, named by its email:

- An account added by one-click setup becomes its own card.
- For an account already in the backend (one added by an older version, say), add another Gemini Web account in Magpie and pick **「添加本地后端里已有的 Google 账号」** (add an account already in the local backend), then choose it from the list. The old `API key …` sign-in can then go: it shows the whole pool as one card (each window at the account that has used the most).

Note that the backend picks the Google account for each request from its pool in turn: how Magpie spreads requests over the cards doesn't decide which account serves them. Only the one-click local backend has usage; a backend you connect to yourself keeps its cookies out of the plugin's reach.

To send Google fewer requests, usage isn't read on every refresh. An account is read again once the backend has used it or one of its windows has reset, and never twice within 10 minutes. An idle account is read at most every 6 hours, which also picks up what you used in the Gemini web app.

Usage and emails are read the way the backend reaches Google for that account. When that way isn't certain, nothing is read and the card says why:

- the backend has a proxy pool, but the account isn't bound to a proxy yet (the backend binds it on its first request);
- the account's proxy is disabled, or is a SOCKS proxy.

So with a proxy pool, an account just added by one-click setup has no email yet. Send one request with it, sign in to it again with **「添加本地后端里已有的 Google 账号」**, then remove the sign-in without an email.

## Limitations (Gemini Web)

- Upstream emulates tool calls with prompts, so they aren't always reliable. Flash models often don't call tools.
- Only text models whose names start with `gemini-` are exposed. A `cost` of 0 doesn't reflect your actual Google quota.

## Google AI Studio (`ai-studio`)

Uses Google AI Studio through [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) (pinned to v0.2.12). Unlike Gemini Web, tool calls use native Function Calling, thinking models offer four levels in Magpie, `minimal` / `low` / `medium` / `high` (`minimal` is the fastest and uses the least quota), and generation needs no browser.

### Getting started

1. Sign in to Google AI Studio and choose **用 Google 账号登录（推荐）** (sign in with a Google account). The first time, the plugin downloads AIStudio2API, verifies its SHA-256 and starts it in the background.
2. Sign in to your Google account in the separate login window that opens (your usual browser is not affected), then close it. The first time, the login browser Camoufox (about 300 MB) is downloaded first, so the window can take a few minutes to appear while Magpie shows no change; the login must finish within 15 minutes.

Choosing it again later lists:

- **添加新的 Google 账号** (add a new Google account): opens the login window for another account;
- **the accounts already on this machine**: makes a card for one at once; one marked as needing to sign in again opens the login window to do so.

Each Google account gets a card of its own. As with Gemini Web, the local service picks the account for each request (one until it cools down, then the next), whichever card Magpie uses.

If you run AIStudio2API yourself, choose **连接已有 AIStudio2API** (connect an existing AIStudio2API) and enter its address (default `http://127.0.0.1:2048/v1`) and `PROXY_API_KEY`.

Usage card: AI Studio reports no remaining quota. The card shows the models the account is cooling down on and when each comes back, or that the account needs to sign in again.

### Plugin options

`allowTools`, `allowImages`, `requestTimeoutMs` and `modelTimeoutMs` apply to both providers; the other AI Studio options go under `studio`. The root `baseURL`, `contextLimit`, `outputLimit` and `stripCitations` apply to Gemini Web only.

```bash
magpie plugin options magpie-gemini-web '{"studio":{"proxy":"http://127.0.0.1:7890"}}'
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `studio.proxy` | none | Proxy for reaching Google (http / https / socks5). The `AI_STUDIO_PROXY` environment variable works too |
| `studio.baseURL` | `http://127.0.0.1:2048/v1` | Default address for connecting an existing AIStudio2API |
| `studio.contextLimit` / `studio.outputLimit` | the model catalog's | Limits declared to clients; they can only lower the catalog's |
| `studio.allowTools` etc. | as at the root | Override the root option of the same name for AI Studio only |

AI Studio replies keep their citation marks such as `[cite: 1]`; they can't be stripped.

### Command line

When an error from the plugin asks you to run a command, it gives the command with its full path, ready to copy. In the plugin's directory you can also use:

| Command | What it does |
| :--- | :--- |
| `npm run studio:status` | Show the service and account status |
| `npm run studio:start` / `studio:stop` | Start / stop the local service |
| `npm run studio:login` | Add a Google account |
| `npm run studio:relogin -- [<account>]` | Sign an expired account in again (optional when only one is) |
| `npm run studio:install -- --archive <file>` | Install offline from a downloaded archive |
| `node scripts/studio.mjs import <dir>` | Import existing accounts while the service is stopped |
| `npm run studio:smoke` | Live acceptance run (uses account quota) |

### Security and data

- The service listens on `127.0.0.1` only; Magpie keeps a locally generated API key.
- Data directory: `~/.local/share/magpie-ai-studio` (override with `AI_STUDIO_DATA_DIR`). The log is `backend.log`, started afresh on the next start once it passes 10 MB.
- A first setup uses port 2048, or another free port when 2048 is taken (by an AIStudio2API of your own, say), saved in the data directory's `config.json`.
- The downloaded archive stays in the data directory; installing again uses it when its checksum matches.
- Supported on macOS, Linux (x64 / arm64) and Windows x64.

## Native Task on macOS (experimental)

On macOS, sign-in offers one more option, "macOS 原生 Task（实验性）": requests skip the Gemini Web backend and go to a local daemon that runs them in Gemini.app's own Task mode, with tool calls on its native Function Calling channel, as the model `gemini-task-argon`. Windows and Linux don't offer it; keep using one-click setup there.

This is an alpha: it supports only the verified Gemini.app build, needs a local setup first (Gemini.app signed in, plus session templates), has passed only one live tool round trip against real Argon, and shows no usage; if an agent is interrupted before it returns a tool result, that call holds the only Task slot for up to about 4 minutes. See [native-task/README.md](native-task/README.md) for setup, session requirements and limitations.

## Default optimized backend and rollback

Starting with plugin **0.4.1**, one-click setup uses [4.22.0-magpie.1](https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/backend-v4.22.0-magpie.1). It includes the changes that previously required a manual build: stable XSRF caching, cancellation propagation for the main generation and upload requests, early completion after complete tool calls, browser headers, and verification of the returned Argon model. Your Google account still needs access to the requested model.

**Upgrading an existing installation:** the plugin leaves a running backend alone. Stop the existing backend process (its process ID is in `backend.pid` in the data directory), then start Magpie or send a request. A stopped old official backend is upgraded automatically, preserving configuration, the cookie database and API keys. Explicitly installed local Argon builds are kept; to replace one with the published build, stop it and run `backend:install` below.

To roll back, stop the backend and run this from the plugin directory:

```bash
npm run backend:install:upstream
```

This installs the checksum-verified official v4.22.0 and saves the selection, so automatic starts keep using upstream. To restore the default optimized build:

```bash
npm run backend:install
```

A failed download or checksum verification keeps the previous binary. On Windows, stop the old process before replacing its executable.

The backend release includes source and build metadata. Developers with Git, Node 22+ and Go 1.27.1 can reproduce all six builds and compare the pinned hashes from this repository:

```bash
npm run backend:release:build
```

The script extracts clean sources from the pinned upstream commit and applies `patches/argon.patch`; it never changes the developer's `backend-source` working tree. See [docs/backend-release.md](docs/backend-release.md) for the release procedure.

## License

MIT. The upstream gemini-web2api-go project is also MIT (see `LICENSE-UPSTREAM`).

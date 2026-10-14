# magpie-gemini-web

[中文](README.md) | English

Use Gemini on the web through your Google account in [Magpie](https://usemagpie.ai/). The plugin runs the [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) backend on your machine. The backend turns the Gemini web app into an OpenAI-compatible API.

## Getting started

1. Install **magpie-gemini-web** from the Magpie plugin market.
2. Sign in to Gemini Web and choose **一键配置本地 Gemini Web (one-click local setup, recommended)**. The plugin downloads the backend, verifies it and starts it in the background.
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

## Plugin options

Tool calls and image input are off by default. Turn them on if a coding agent needs tools:

```bash
magpie plugin options magpie-gemini-web '{"allowTools":true,"allowImages":true}'
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `allowTools` | `false` | Allows tool calls (experimental). When off, requests with tools get a 400 |
| `allowImages` | `false` | Allows image input |
| `baseURL` | `http://127.0.0.1:8083/v1` | Default backend URL |
| `contextLimit` / `outputLimit` | `32768` / `8192` | Context and output limits reported to clients |
| `requestTimeoutMs` / `modelTimeoutMs` | `240000` / `10000` | Timeouts in ms for requests and for fetching the model list |

## Thinking effort

You can switch a model between `low` and `high` effort in Magpie if it has a `-thinking` version. `low` uses the base model and `high` uses the `-thinking` model with extended thinking. After upgrading the plugin, run `magpie provider models gemini-web` to refresh the model list. Argon's medium tier will be added once upstream supports it ([#5](https://github.com/BUKOWSKIREAL/magpie-gemini-web/issues/5)).

## Security and data

- The backend listens on `127.0.0.1` only. Your cookie goes only to that local backend, and Magpie stores a locally generated API key instead.
- The plugin pins the official v4.22.0 backend binary and checks its SHA-256 on download and on every start. Builds are available for macOS, Linux and Windows on x64 and arm64.
- The data directory is `~/.local/share/magpie-gemini-web` (set `GEMINI_WEB_DATA_DIR` to change it). The backend writes its log to `backend.log` there.
- The plugin sends one request at a time, but this can't guarantee that Google won't flag your account. Use it at your own risk.

## Usage

Magpie's usage cards show each Google account's **5-hour** and **weekly** usage and reset times, as <https://gemini.google.com/usage> does. Each Google account gets a card of its own, named by its email:

- An account added by one-click setup becomes its own card.
- For an account already in the backend (one added by an older version, say), add another Gemini Web account in Magpie and pick **「添加本地后端里已有的 Google 账号」** (add an account already in the local backend), then choose it from the list. The old `API key …` sign-in can then go: it shows the whole pool as one card (each window at the account that has used the most).

Note that the backend picks the Google account for each request from its pool in turn: how Magpie spreads requests over the cards doesn't decide which account serves them. Only the one-click local backend has usage; a backend you connect to yourself keeps its cookies out of the plugin's reach.

## Limitations

- Upstream emulates tool calls with prompts, so they aren't always reliable. Flash models often don't call tools.
- Only text models whose names start with `gemini-` are exposed. A `cost` of 0 doesn't reflect your actual Google quota.

## Argon patched build (optional)

The official backend already supports `gemini-4-argon`, which needs a paid or Ultra account. This repo's patched build also verifies that responses really come from Argon, so a silent downgrade is caught, and it lowers latency. Building it requires Go 1.26+:

```bash
git clone https://github.com/BUKOWSKIREAL/magpie-gemini-web.git && cd magpie-gemini-web
git clone https://github.com/zexadev/gemini-web2api-go.git backend-source
git -C backend-source checkout a65b1d1a5ac614c1b455857334b4f1c73ab8fcfb
git -C backend-source apply ../patches/argon.patch
npm run backend:build:argon
npm run backend:install:argon
```

Restart Magpie when the install finishes, and the plugin starts the Argon build in the background. If an older backend is still running, stop it first with `kill $(cat ~/.local/share/magpie-gemini-web/backend.pid)`. Run `npm run backend:install` to switch back to the official build.

## License

MIT. The upstream gemini-web2api-go project is also MIT (see `LICENSE-UPSTREAM`).

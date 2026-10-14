import { normalizeBaseURL, settings, credentials, listModels, forward, UNREACHABLE_HEADER } from './lib/backend.mjs';
import { ensureBackend, localBackend } from './lib/native.mjs';
import { parseCookieInput, importCookie } from './lib/setup.mjs';

const ID = 'gemini-web';
const GEMINI_URL = 'https://gemini.google.com/app';

const COOKIE_STEPS = [
  `在浏览器打开 ${GEMINI_URL}，确认已登录要使用的 Google 账号，然后：`,
  '1. 按 F12（macOS 按 ⌥⌘I）打开开发者工具，切到 Network（网络）面板，刷新页面',
  '2. 点列表里任意一个 gemini.google.com 的请求 → Headers（标头）→ Request Headers（请求标头）',
  '3. 找到 cookie 那一行，复制它的值，粘贴到下面',
  'Cookie 只保存在本机的 Gemini Web 后端里，不会发到别处。'
].join('\n');

// managedBackend is the local backend this plugin set up, when baseURL points at it.
function managedBackend(baseURL) {
  const local = localBackend();
  return local && local.baseURL === baseURL ? local : null;
}

// forwardManaged is forward(), but when the backend this plugin manages can't be reached it
// starts the backend and tries once more.
async function forwardManaged(input, init, getAuth, opts) {
  const retryInput = input instanceof Request ? input.clone() : input;
  const res = await forward(input, init, getAuth, opts);
  if (res.headers.get(UNREACHABLE_HEADER) !== 'unreachable') return res;
  let c;
  try {
    c = credentials(await getAuth(), opts);
  } catch {
    return res;
  }
  if (!managedBackend(c.baseURL)) return res;
  try {
    await ensureBackend();
  } catch {
    return res;
  }
  return forward(retryInput, init, getAuth, opts);
}

export const GeminiWebPlugin = async (_input, options = {}) => {
  const opts = settings(options);

  // Bring a backend set up earlier back after Magpie or the computer restarts. Not awaited:
  // requests that arrive first start it themselves through forwardManaged.
  if (localBackend()) {
    ensureBackend().catch(err => console.error(`[gemini-web] could not start the local backend: ${err.message}`));
  }

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[ID] ??= { name: 'Gemini Web', npm: '@ai-sdk/openai-compatible', api: opts.baseURL, models: {} };
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [{
        type: 'oauth',
        label: '一键配置本地 Gemini Web（推荐）',
        // Installs and starts the pinned backend, then takes the Gemini cookie the user pastes.
        // The result carries the backend's own API key, so Magpie saves an API-key sign-in.
        async authorize() {
          const local = await ensureBackend();
          return {
            url: GEMINI_URL,
            method: 'code',
            instructions: COOKIE_STEPS,
            async callback(code) {
              try {
                await importCookie(local, parseCookieInput(code));
              } catch (err) {
                return { type: 'failed', error: err.message };
              }
              return { type: 'success', key: local.apiKey, metadata: { baseURL: local.baseURL } };
            }
          };
        }
      }, {
        type: 'api',
        label: '连接已有后端（自定义地址 + API key）',
        placeholder: 'Backend API key (not a Google cookie)',
        prompts: [{
          type: 'text',
          key: 'baseURL',
          message: 'Backend OpenAI base URL (blank: plugin default)',
          placeholder: opts.baseURL,
          validate: value => {
            try {
              normalizeBaseURL(value || opts.baseURL);
            } catch (e) {
              return e.message;
            }
          }
        }],
        // Magpie stores raw prompt inputs as metadata unless authorize returns its own;
        // write the resolved URL so a blank answer doesn't persist as baseURL: "".
        authorize: async inputs => ({
          type: 'success',
          metadata: { baseURL: normalizeBaseURL(inputs?.baseURL || opts.baseURL) }
        })
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return {};
        const c = credentials(auth, opts);
        return {
          apiKey: c.key,
          baseURL: c.baseURL,
          fetch: (input, init) => forwardManaged(input, init, getAuth, opts)
        };
      }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        const c = credentials(auth, opts);
        try {
          return await listModels(c, opts);
        } catch (err) {
          if (!err.unreachable || !managedBackend(c.baseURL)) throw err;
          await ensureBackend();
          return listModels(c, opts);
        }
      }
    }
  };
};

export default GeminiWebPlugin;

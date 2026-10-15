import { normalizeBaseURL, settings, credentials, listModels, forward, UNREACHABLE_HEADER } from './lib/backend.mjs';
import { ensureBackend, localBackend } from './lib/native.mjs';
import { parseCookieInput, importCookie } from './lib/setup.mjs';
import { usage, poolChoices, poolAccounts, accountEmail } from './lib/usage.mjs';
import { taskSupported, taskMethod, taskLoader, taskModels, isTaskAuth } from './lib/task.mjs';

const ID = 'gemini-web';
const GEMINI_URL = 'https://gemini.google.com/app';

// The backend keeps the session alive by rotating its cookies, which signs the browser it came
// from out of Google. A private window that is closed afterwards gives the backend a session of
// its own.
const COOKIE_STEPS = [
  '请用浏览器的无痕 / 隐私窗口（推荐 Firefox），不要用你平时登录着 Google 的窗口：后端会定时刷新这份登录，和浏览器共用会被 Google 踢出登录。',
  `1. 在无痕窗口打开 ${GEMINI_URL} 并登录要使用的 Google 账号`,
  '2. 按 F12（macOS 按 ⌥⌘I）打开开发者工具，切到 Network（网络）面板，刷新页面',
  '3. 点列表里任意一个 gemini.google.com 的请求 → Headers（标头）→ Request Headers（请求标头）',
  '4. 找到 cookie 那一行，复制它的值，粘贴到下面',
  '5. 直接关掉无痕窗口，不要点「退出登录」（退出会让这份 Cookie 失效）',
  'Cookie 只保存在本机的 Gemini Web 后端里，不会发到别处。'
].join('\n');

// signInFor is the Magpie sign-in for one account of the local backend's pool: the backend's
// key, with the account's id for its usage card and its Google email, which names the card and
// keeps each Google account a sign-in of its own (Magpie takes two sign-ins with one email for
// one account, and two with neither for one when their key is the same). The account is the
// pool's own entry (see poolAccounts), which says the way out to read the email by; without
// one the email isn't read.
async function signInFor(local, account) {
  const email = account.email || await accountEmail(account).catch(() => undefined);
  return {
    type: 'success',
    key: local.apiKey,
    metadata: { baseURL: local.baseURL, account: account.id, ...(email ? { email } : {}) }
  };
}

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
        // The result carries the backend's own API key, so Magpie saves an API-key sign-in,
        // one for each Google account (see signInFor).
        async authorize() {
          const local = await ensureBackend();
          return {
            url: GEMINI_URL,
            method: 'code',
            instructions: COOKIE_STEPS,
            async callback(code) {
              let cookie, added;
              try {
                cookie = parseCookieInput(code);
                added = await importCookie(local, cookie);
              } catch (err) {
                return { type: 'failed', error: err.message };
              }
              const account = (await poolAccounts().catch(() => [])).find(a => a.id === added.id);
              return signInFor(local, account || { id: added.id });
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
      }, {
        type: 'oauth',
        label: '添加本地后端里已有的 Google 账号',
        // Magpie asks through ask(), listing the pool as it is now; prompts holds the question
        // for OpenCode, and makes Magpie hand authorize the answer.
        prompts: [{ type: 'select', key: 'account', message: '选择 Google 账号', options: [] }],
        async ask(inputs) {
          if (inputs?.account) return null;
          if (!localBackend()) throw new Error('还没有本地后端：请先用「一键配置本地 Gemini Web」');
          const choices = await poolChoices();
          if (!choices.length) throw new Error('本地后端里没有启用的 Google 账号');
          return {
            type: 'select',
            key: 'account',
            message: '选择 Google 账号',
            placeholder: '',
            options: choices.map(c => ({ label: c.label, value: String(c.id), hint: c.hint }))
          };
        },
        async authorize(inputs) {
          const local = localBackend();
          if (!local) throw new Error('还没有本地后端：请先用「一键配置本地 Gemini Web」');
          const id = Number(inputs?.account);
          const chosen = (await poolChoices()).find(c => c.id === id);
          if (!chosen) throw new Error(`本地后端里没有启用的账号 #${inputs?.account}`);
          return {
            url: '',
            method: 'auto',
            instructions: '',
            callback: async () => signInFor(local, chosen)
          };
        }
      }, ...(taskSupported() ? [taskMethod] : [])],
      async loader(getAuth) {
        const auth = await getAuth();
        if (isTaskAuth(auth)) return taskLoader(auth);
        if (auth?.type !== 'api') return {};
        const c = credentials(auth, opts);
        return {
          apiKey: c.key,
          baseURL: c.baseURL,
          fetch: (input, init) => forwardManaged(input, init, getAuth, opts)
        };
      },
      // Magpie's usage card: the 5-hour and weekly limits of each Google account in the local
      // backend's pool, as gemini.google.com/usage shows them. A backend this plugin doesn't
      // manage keeps its accounts out of reach. No read marks the sign-in: the Magpie key
      // belongs to the backend, not to Google.
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return { error: 'Gemini Web 还没有登录', windows: [], signIn: 'kept' };
        if (isTaskAuth(auth)) return { error: '原生 Task 登录读不到额度', windows: [], signIn: 'kept' };
        let c;
        try {
          c = credentials(auth, opts);
        } catch (err) {
          return { error: err.message, windows: [], signIn: 'kept' };
        }
        if (!managedBackend(c.baseURL)) {
          return { error: '只能读取插件自己管理的本地后端的额度（连接已有后端时读不到）', windows: [], signIn: 'kept' };
        }
        const { account, email } = auth.metadata || {};
        return { ...(await usage(Number.isInteger(account) ? { account, email } : {})), signIn: 'kept' };
      }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        if (isTaskAuth(auth)) return taskModels(auth, ID);
        const c = credentials(auth, opts);
        try {
          return await listModels(c, opts);
        } catch (err) {
          if (!err.unreachable || !managedBackend(c.baseURL)) throw err;
          await ensureBackend();
          return listModels(c, opts);
        }
      }
    },
    // The Task bridge keeps a conversation's state by its session, so each request carries the
    // host's session id. The Web backend's forward() passes on only the headers it needs, so
    // this doesn't reach it.
    async 'chat.headers'(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return;
      if (typeof input.sessionID === 'string' && input.sessionID) {
        output.headers ??= {};
        output.headers['X-Gemini-Session'] = input.sessionID;
      }
    }
  };
};

export default GeminiWebPlugin;

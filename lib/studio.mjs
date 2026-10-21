import { normalizeBaseURL, credentials, forward, makeOpenAIError, UNREACHABLE_HEADER } from './backend.mjs';
import path from 'node:path';
import { localStudio, ensureStudio, studioAdmin, studioAccounts, studioProxy, studioCommand, validateProxy, isConnectRefused, PROXY_SOURCES } from './studio-native.mjs';

export const STUDIO_ID = 'ai-studio';
export const STUDIO_BASE = 'http://127.0.0.1:2048/v1';

const STUDIO_EXCLUDE = /(?:image|nano-banana|tts|audio|live|transcribe|robotics|research|video|music|canvas)/i;
// Catalog capabilities of models made for images, speech or live sessions. Such a model can be
// marked chat_model and named like a text model too (gemini-omni-*), so the name can't tell.
const NON_TEXT_CAPS = ['image_route', 'speech_route', 'live_route', 'aspect_ratio', 'output_resolution', 'interactions_api', 'transcription_output'];
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// The service opens its own login window for a new account, and waits this long for it.
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
// Upstream logs in with Camoufox even when generation runs in Go, and downloads it on the first
// login, so that one can take minutes before a window shows.
const LOGIN_WINDOW = [
  '第一次登录要先下载登录用的浏览器 Camoufox（约 300 MB），可能要等几分钟窗口才出现，期间这里没有变化，请耐心等待。',
  '登录窗口是独立的，不影响你平时用的浏览器；请在 15 分钟内完成登录，完成后可以关掉窗口，日常生成不需要浏览器。'
];
const LOGIN_STEPS = [
  ...LOGIN_WINDOW,
  '想加更多 Google 账号，再来一次即可，每个账号一张卡片。'
].join('\n');
const RELOGIN_STEPS = LOGIN_WINDOW.join('\n');
// AdminAccount.state as the account list shows it
const ACCOUNT_STATES = {
  ready: '可用',
  busy: '使用中',
  cooldown: '冷却中',
  auth_required: '需要重新登录',
  unavailable: '暂时不可用',
  disabled: '已停用'
};
const SIGN_IN_METHOD = '用 Google 账号登录（推荐）';
// How to sign an account in again, or add one, as messages say it
const SIGN_IN_HOW = `在 Magpie 里登录 Google AI Studio，选「${SIGN_IN_METHOD}」`;
// The choice of a new account among the local service's (whose ids are emails, so none is this)
const NEW_ACCOUNT = '+new';

const KNOWN_STUDIO_NESTED = new Set([
  'baseURL',
  'allowTools',
  'allowImages',
  'contextLimit',
  'outputLimit',
  'requestTimeoutMs',
  'modelTimeoutMs',
  'proxy',
  'stripCitations'
]);

export function studioSettings(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Plugin options must be an object');
  }

  let allowTools = true;
  if (options.allowTools !== undefined) {
    if (typeof options.allowTools !== 'boolean') {
      throw new Error('Invalid option allowTools: must be a boolean');
    }
    allowTools = options.allowTools;
  }

  let allowImages = false;
  if (options.allowImages !== undefined) {
    if (typeof options.allowImages !== 'boolean') {
      throw new Error('Invalid option allowImages: must be a boolean');
    }
    allowImages = options.allowImages;
  }

  let requestTimeoutMs = 30 * 60 * 1000;
  if (options.requestTimeoutMs !== undefined) {
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error('Invalid option requestTimeoutMs: must be a positive integer');
    }
    requestTimeoutMs = options.requestTimeoutMs;
  }

  let modelTimeoutMs = 10000;
  if (options.modelTimeoutMs !== undefined) {
    if (!Number.isInteger(options.modelTimeoutMs) || options.modelTimeoutMs <= 0) {
      throw new Error('Invalid option modelTimeoutMs: must be a positive integer');
    }
    modelTimeoutMs = options.modelTimeoutMs;
  }

  let baseURL = STUDIO_BASE;
  let proxy;
  let explicitContextLimit = null;
  let explicitOutputLimit = null;

  if (options.studio !== undefined) {
    if (!options.studio || typeof options.studio !== 'object' || Array.isArray(options.studio)) {
      throw new Error('Invalid option studio: must be an object');
    }
    for (const key of Object.keys(options.studio)) {
      if (!KNOWN_STUDIO_NESTED.has(key)) {
        throw new Error(`Unknown studio option: ${key}`);
      }
    }

    const s = options.studio;
    if (s.stripCitations !== undefined && s.stripCitations !== false) {
      throw new Error('Invalid option stripCitations: AI Studio citations cannot be stripped (must be false)');
    }

    if (s.baseURL !== undefined) {
      baseURL = normalizeBaseURL(s.baseURL);
    }
    if (s.proxy !== undefined) {
      proxy = validateProxy(s.proxy);
    }
    if (s.allowTools !== undefined) {
      if (typeof s.allowTools !== 'boolean') {
        throw new Error('Invalid option studio.allowTools: must be a boolean');
      }
      allowTools = s.allowTools;
    }
    if (s.allowImages !== undefined) {
      if (typeof s.allowImages !== 'boolean') {
        throw new Error('Invalid option studio.allowImages: must be a boolean');
      }
      allowImages = s.allowImages;
    }
    if (s.requestTimeoutMs !== undefined) {
      if (!Number.isInteger(s.requestTimeoutMs) || s.requestTimeoutMs <= 0) {
        throw new Error('Invalid option studio.requestTimeoutMs: must be a positive integer');
      }
      requestTimeoutMs = s.requestTimeoutMs;
    }
    if (s.modelTimeoutMs !== undefined) {
      if (!Number.isInteger(s.modelTimeoutMs) || s.modelTimeoutMs <= 0) {
        throw new Error('Invalid option studio.modelTimeoutMs: must be a positive integer');
      }
      modelTimeoutMs = s.modelTimeoutMs;
    }
    if (s.contextLimit !== undefined) {
      if (!Number.isInteger(s.contextLimit) || s.contextLimit <= 0) {
        throw new Error('Invalid option studio.contextLimit: must be a positive integer');
      }
      explicitContextLimit = s.contextLimit;
    }
    if (s.outputLimit !== undefined) {
      if (!Number.isInteger(s.outputLimit) || s.outputLimit <= 0) {
        throw new Error('Invalid option studio.outputLimit: must be a positive integer');
      }
      explicitOutputLimit = s.outputLimit;
    }
    if (explicitContextLimit !== null && explicitOutputLimit !== null && explicitOutputLimit > explicitContextLimit) {
      throw new Error('Invalid option studio.outputLimit: cannot exceed contextLimit');
    }
  }

  return {
    baseURL,
    allowTools,
    allowImages,
    requestTimeoutMs,
    modelTimeoutMs,
    proxy,
    stripCitations: false,
    nativeThinking: true,
    explicitContextLimit,
    explicitOutputLimit
  };
}

export async function listStudioModels(c, opts) {
  const url = `${c.baseURL}/models`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${c.key}`,
        'Accept': 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.modelTimeoutMs)
    });
  } catch (err) {
    const error = new Error('Failed to reach AI Studio backend models endpoint: ' + (err?.message || err));
    error.status = 502;
    error.unreachable = true;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`Failed to list AI Studio models: HTTP ${res.status}`);
    error.status = res.status;
    if (res.status === 401) {
      error.signIn = 'expired';
    }
    throw error;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Invalid models response: failed to parse JSON');
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
    throw new Error('Invalid models response: expected data array');
  }

  const result = Object.create(null);
  const seen = new Set();
  // A model no enabled account's subscription covers is listed without channels, and calls to it
  // get a 403. A backend that lists no channels at all is older than that rule: keep its models.
  const listsChannels = body.data.some(item => Array.isArray(item?.channels));

  for (const item of body.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
      throw new Error('Invalid model entry in response: expected object with string id');
    }
    const id = item.id;
    if (!id || CONTROL_CHARS.test(id)) {
      throw new Error('Invalid model entry in response: invalid id format');
    }
    if (!id.startsWith('gemini-')) continue;
    // Build assistant models inject Google's coding-agent prompt and do not expose
    // ordinary function calling. Keep them out of this general-purpose provider.
    if (STUDIO_EXCLUDE.test(id) || /-build$/i.test(id)) continue;

    const methods = Array.isArray(item.supported_generation_methods) ? item.supported_generation_methods : [];
    if (!methods.includes('generateContent')) continue;

    const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
    if (caps.chat_model !== true || caps.assistant_route === true) continue;
    if (NON_TEXT_CAPS.some(cap => caps[cap] === true)) continue;
    if (listsChannels && !(Array.isArray(item.channels) && item.channels.length > 0)) continue;

    if (seen.has(id)) continue;
    seen.add(id);

    const upstreamInput = Number.isInteger(item.input_token_limit) && item.input_token_limit > 0
      ? item.input_token_limit
      : 1000000;
    const upstreamOutput = Number.isInteger(item.output_token_limit) && item.output_token_limit > 0
      ? item.output_token_limit
      : 8192;

    let context = opts.explicitContextLimit ? Math.min(upstreamInput, opts.explicitContextLimit) : upstreamInput;
    let output = opts.explicitOutputLimit ? Math.min(upstreamOutput, opts.explicitOutputLimit) : upstreamOutput;
    output = Math.min(output, context);

    const toolcall = Boolean(opts.allowTools && caps.function_declarations === true);
    const reasoning = Boolean(caps.thinking === true || caps.thinking_level === true);
    // Of the levels the backend takes, none is the lowest one again and xhigh/max are high.
    const variants = caps.thinking_level === true ? { minimal: {}, low: {}, medium: {}, high: {} } : {};
    const image = Boolean(opts.allowImages && caps.media_resolution === true);

    result[id] = {
      id,
      providerID: STUDIO_ID,
      name: item.name || id,
      api: {
        id,
        url: c.baseURL,
        npm: '@ai-sdk/openai-compatible'
      },
      limit: {
        context,
        output
      },
      capabilities: {
        temperature: true,
        reasoning,
        attachment: image,
        toolcall,
        input: {
          text: true,
          image
        },
        output: {
          text: true
        }
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0
        }
      },
      options: {},
      headers: {},
      variants,
      status: 'active'
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error('No usable Gemini models found in AI Studio response');
  }

  return result;
}

function sameBackend(c, local) {
  return c.key === local.apiKey && c.baseURL === local.baseURL;
}

function managedMismatch() {
  const err = new Error('Managed AI Studio key or baseURL mismatch; please re-authenticate');
  err.signIn = 'expired';
  return err;
}

// staleManagedSignIn says whether a managed sign-in names a key or URL the local service no
// longer has. Without a local setup there is nothing to tell by: the request finds out when it
// reaches the service, which is installed again if it is down. Unusable credentials are left to
// forward(), which answers them as an expired sign-in.
function staleManagedSignIn(auth, opts) {
  const local = localStudio(opts);
  if (!local) return false;
  let c;
  try {
    c = credentials(auth, opts);
  } catch {
    return false;
  }
  return !sameBackend(c, local);
}

async function forwardManagedStudio(input, init, getAuth, opts) {
  const retryInput = input instanceof Request ? input.clone() : input;

  const auth = await getAuth();
  if (auth?.metadata?.managed === true && staleManagedSignIn(auth, opts)) {
    return makeOpenAIError(401, 'Managed AI Studio key or baseURL changed; sign in to AI Studio again');
  }

  const callerSignal = input instanceof Request ? input.signal : init?.signal;
  const res = await forward(input, init, getAuth, { ...opts, nativeThinking: true, stripCitations: false });
  if (res.headers.get(UNREACHABLE_HEADER) !== 'unreachable') return res;

  if (callerSignal?.aborted) return res;
  if (!auth?.metadata?.managed) return res;

  try {
    await ensureStudio({ ...opts, proxy: opts.proxy });
  } catch {
    return res;
  }

  if (callerSignal?.aborted) return res;
  return forward(retryInput, init, getAuth, { ...opts, nativeThinking: true, stripCitations: false });
}

// accountSignIn is the Magpie sign-in for one Google account of the local service: the service's
// key, with the account's id for its usage card and its email (the account's label, or its id,
// which upstream makes the lowercased email), which names the card and keeps each account a
// sign-in of its own, as Gemini Web's are. The service still picks the account for each request
// itself (fill-first): a sign-in can't pin one.
function accountSignIn(local, account) {
  return {
    type: 'success',
    key: local.apiKey,
    metadata: { mode: 'studio', managed: true, baseURL: local.baseURL, account: account.id, email: labelOf(account) }
  };
}

const SERVING_STATES = new Set(['ready', 'busy', 'cooldown']);
const labelOf = a => String(a.label || a.id);

// cooldownWindows is the usage card's windows for the pool's cooldowns (AdminCooldown, one for each
// account and model): one window a model, as full as the share of its accounts cooling down on it,
// so a full one is a model no account can serve now, and starting again when the first of them
// does. A cooldown with no model stands for all of an account's models.
export function cooldownWindows(cooldowns, accounts, now = Date.now()) {
  const serving = accounts.filter(a => SERVING_STATES.has(a.state));
  const byModel = new Map();
  for (const c of cooldowns) {
    const until = Date.parse(c?.until ?? '');
    if (!c || !Number.isFinite(until) || until <= now) continue;
    const model = typeof c.model_id === 'string' ? c.model_id : '';
    const m = byModel.get(model) ?? { accounts: new Set(), until: Infinity, reasons: new Set() };
    m.accounts.add(c.account_id);
    m.until = Math.min(m.until, until);
    if (typeof c.reason === 'string' && c.reason.trim()) m.reasons.add(c.reason.trim());
    byModel.set(model, m);
  }
  const out = [];
  for (const [model, m] of byModel) {
    const serves = serving.filter(a => !model || !Array.isArray(a.models) || !a.models.length || a.models.includes(model)).length;
    const total = Math.max(serves, m.accounts.size);
    const [reason] = m.reasons;
    const why = m.reasons.size === 1 && reason.length <= 40 ? `：${reason}` : '';
    out.push({
      name: model || '所有模型',
      used: Math.round((m.accounts.size / total) * 100),
      resetsAt: new Date(m.until).toISOString(),
      display: `${m.accounts.size}/${total} 个账号冷却中${why}`
    });
  }
  return out.sort((a, b) => b.used - a.used || Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
}

// accountUsage is the usage card of one account of the local service: its own cooldowns, one
// window a model (or one for all its models), full until the cooldown ends; an account that can't
// serve says why instead.
export function accountUsage(account, cooldowns, now = Date.now()) {
  const user = labelOf(account);
  if (account.state === 'auth_required') {
    return { user, error: `这个 Google 账号需要重新登录：${SIGN_IN_HOW}，再选这个账号`, windows: [] };
  }
  if (!SERVING_STATES.has(account.state)) {
    const why = ACCOUNT_STATES[account.state] || account.state || '暂时不可用';
    return { user, error: `这个 Google 账号${why}${account.message ? `：${account.message}` : ''}`, windows: [] };
  }
  const windows = [];
  for (const c of cooldowns) {
    const until = Date.parse(c?.until ?? '');
    if (c?.account_id !== account.id || !Number.isFinite(until) || until <= now) continue;
    const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
    windows.push({
      name: typeof c.model_id === 'string' && c.model_id ? c.model_id : '所有模型',
      used: 100,
      resetsAt: new Date(until).toISOString(),
      display: reason && reason.length <= 40 ? `冷却中：${reason}` : '冷却中'
    });
  }
  return { user, windows: windows.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) };
}

// poolUsage is the usage card of the local service's accounts: they go by their labels (Google
// emails), with the ones that can't serve counted beside them. The service gives no allowance to
// show, only the models its accounts cool down on (see cooldownWindows); a pool none of whose
// accounts can serve until one signs in again is an error, since every request fails.
export function poolUsage(accounts, cooldowns, now = Date.now()) {
  if (!accounts.length) {
    return { error: `本地 AI Studio 里还没有 Google 账号：${SIGN_IN_HOW}`, windows: [] };
  }
  const expired = accounts.filter(a => a.state === 'auth_required').length;
  const unavailable = accounts.filter(a => a.state === 'unavailable').length;
  const named = accounts.length > 1 ? `${labelOf(accounts[0])} +${accounts.length - 1}` : labelOf(accounts[0]);
  const notes = [];
  if (expired) notes.push(`${expired} 个需要重新登录`);
  if (unavailable) notes.push(`${unavailable} 个暂时不可用`);
  const user = notes.length ? `${named}（${notes.join('，')}）` : named;
  if (!accounts.some(a => SERVING_STATES.has(a.state))) {
    const error = expired
      ? `${expired} 个 Google 账号都需要重新登录：${SIGN_IN_HOW}，再选要重新登录的账号`
      : '本地 AI Studio 的 Google 账号暂时都不可用';
    return { user, error, windows: [] };
  }
  return { user, windows: cooldownWindows(cooldowns, accounts, now) };
}

// proxyLine says which proxy the local service goes out through, where that comes from, a saved
// one set aside for another, and what it takes for the one set to apply (see studioProxy).
export function proxyLine(proxy, local) {
  const named = p => p || '不走代理';
  const restart = `重启本地服务（${studioCommand('stop', { dataDir: local.dataDir })}，下一次请求会自动启动）`;
  let line = `${named(proxy.active)}（${PROXY_SOURCES[proxy.source]}）`;
  if (proxy.overridden === 'unknown') {
    line += `；管理页保存的是 ${named(proxy.saved)}，但服务启动时的环境变量盖住了它（旧版插件启动的服务会这样）。${restart}后应按管理页设置生效；如果由 Magpie 再次启动后仍被盖住，检查插件选项 studio.proxy 和环境变量 AI_STUDIO_PROXY`;
    return line;
  }
  if (proxy.source === 'legacy') {
    return `${line}。如果它来自启动时的环境变量（例如 Magpie 或终端里的 HTTPS_PROXY），${restart}后就不再使用它，改按管理页设置；如果来自系统代理设置，重启后仍会使用`;
  }
  if (proxy.pending === 'restart') {
    line += `；${PROXY_SOURCES[proxy.wantedSource]}设置的是 ${named(proxy.wanted)}，${restart}后生效`;
  } else if (proxy.pending === 'generation') {
    line += proxy.source === 'unknown'
      ? '；管理页有改动还没生效，在管理页重启服务后生效'
      : `；管理页保存的 ${named(proxy.wanted)} 要在管理页重启服务后生效`;
  }
  if (proxy.overridden) {
    const by = PROXY_SOURCES[proxy.overridden];
    line += `；管理页保存的 ${proxy.saved} 被 ${by} 覆盖，不会生效。要改用它，先去掉 ${by}，再${restart}`;
  }
  return line;
}

// serviceWindows are the usage card's lines about the local service itself: the proxy it goes out
// through (when it could be read), and where its admin page is.
function serviceWindows(local, proxy) {
  const windows = [];
  if (proxy) windows.push({ name: '代理出口', used: 0, display: proxyLine(proxy, local) });
  windows.push({
    name: '管理页',
    used: 0,
    display: `${local.origin}（用户名 ${local.adminUsername}，密码是 ${path.join(local.dataDir, 'config.json')} 里的 adminPassword）`
  });
  return windows;
}

export const AIStudioPlugin = async (_input, options = {}) => {
  const opts = studioSettings(options);

  if (localStudio(opts)) {
    ensureStudio({ ...opts, proxy: opts.proxy }).catch(err => {
      console.error(`[ai-studio] could not start the local AI Studio service: ${err.message}`);
    });
  }

  // afterLogin is the sign-in once an account is signed in. Generation may still be starting;
  // the first request waits for it, so a slow start doesn't fail a sign-in that worked (and a
  // retry doesn't open another login window for the same account).
  function afterLogin(local, account) {
    ensureStudio({ proxy: opts.proxy }).catch(err => {
      console.error(`[ai-studio] generation did not start after sign-in: ${err.message}`);
    });
    return accountSignIn(local, account);
  }

  // proxyNote is a line on the proxy the local service goes out through, for a sign-in to show
  // before its login window opens and when it fails: a wrong proxy is the usual reason the window
  // can't reach Google, and nothing else shows it before an account is signed in.
  async function proxyNote(local) {
    if (!local) return '';
    try {
      return `\n本地服务的代理出口：${proxyLine(await studioProxy(local, opts), local)}`;
    } catch {
      return '';
    }
  }

  // addAccount signs a new Google account in through the service's own login window, setting the
  // service up first if this is the first.
  async function addAccount() {
    const ready = await ensureStudio({ proxy: opts.proxy, managementOnly: true });
    return {
      url: '',
      method: 'auto',
      instructions: LOGIN_STEPS + await proxyNote(ready),
      async callback() {
        let local, account;
        try {
          local = await ensureStudio({ proxy: opts.proxy, managementOnly: true });
          const res = await studioAdmin(local, 'POST', '/api/accounts', {}, { timeoutMs: LOGIN_TIMEOUT_MS });
          account = res?.account;
          if (!account || typeof account.id !== 'string' || !account.id || account.enabled === false) {
            throw new Error('AIStudio2API did not return an enabled account');
          }
        } catch (err) {
          return { type: 'failed', error: `Google 登录没有完成：${err.message}${await proxyNote(local)}` };
        }
        return afterLogin(local, account);
      }
    };
  }

  // signInAgain signs an account whose Google sign-in expired in again, in a login window.
  async function signInAgain(ready, chosen) {
    return {
      url: '',
      method: 'auto',
      instructions: RELOGIN_STEPS + await proxyNote(ready),
      async callback() {
        let local;
        try {
          local = await ensureStudio({ proxy: opts.proxy, managementOnly: true });
          const res = await studioAdmin(local, 'POST', `/api/accounts/${encodeURIComponent(chosen.id)}/login`, {}, { timeoutMs: LOGIN_TIMEOUT_MS });
          if (res?.account?.state === 'auth_required') throw new Error(res.account.message || '账号仍然需要重新登录');
        } catch (err) {
          return { type: 'failed', error: `${labelOf(chosen)} 没有重新登录：${err.message}${await proxyNote(local)}` };
        }
        return afterLogin(local, chosen);
      }
    };
  }

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[STUDIO_ID] ??= {
        name: 'Google AI Studio',
        npm: '@ai-sdk/openai-compatible',
        api: opts.baseURL,
        models: {}
      };
    },
    auth: {
      provider: STUDIO_ID,
      maxConcurrency: 1,
      methods: [
        {
          // One way in for a Google account: a new one, one the local service already has, or one
          // of those to sign in again. The first time there is no service yet, and nothing to ask.
          type: 'oauth',
          label: SIGN_IN_METHOD,
          prompts: [{ type: 'select', key: 'account', message: '选择 Google 账号', options: [] }],
          async ask(inputs) {
            if (inputs?.account || !localStudio(opts)) return null;
            await ensureStudio({ proxy: opts.proxy, managementOnly: true });
            const accounts = await studioAccounts(opts);
            if (!accounts.length) return null;
            return {
              type: 'select',
              key: 'account',
              message: '选择 Google 账号',
              placeholder: '',
              options: [
                { label: '添加新的 Google 账号', value: NEW_ACCOUNT, hint: '打开登录窗口' },
                ...accounts.map(a => ({
                  label: labelOf(a),
                  value: a.id,
                  hint: a.state === 'auth_required' ? '需要重新登录：会打开登录窗口' : ACCOUNT_STATES[a.state] || a.state || ''
                }))
              ]
            };
          },
          async authorize(inputs) {
            const id = inputs?.account;
            if (!id || id === NEW_ACCOUNT) return addAccount();
            const local = await ensureStudio({ proxy: opts.proxy, managementOnly: true });
            const chosen = (await studioAccounts(opts)).find(a => a.id === id);
            if (!chosen) throw new Error(`本地 Google AI Studio 里没有启用的账号 ${id}`);
            if (chosen.state === 'auth_required') return signInAgain(local, chosen);
            return { url: '', method: 'auto', instructions: '', callback: async () => accountSignIn(local, chosen) };
          }
        },
        {
          type: 'api',
          label: '连接已有 AIStudio2API（地址 + API key）',
          placeholder: 'AIStudio2API PROXY_API_KEY',
          prompts: [{
            type: 'text',
            key: 'baseURL',
            message: 'AIStudio2API base URL (blank: default http://127.0.0.1:2048/v1)',
            placeholder: opts.baseURL,
            validate: value => {
              try {
                normalizeBaseURL(value || opts.baseURL);
              } catch (e) {
                return e.message;
              }
            }
          }],
          authorize: async inputs => ({
            type: 'success',
            metadata: {
              mode: 'studio',
              managed: false,
              baseURL: normalizeBaseURL(inputs?.baseURL || opts.baseURL)
            }
          })
        }
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return {};
        const c = credentials(auth, opts);
        if (auth.metadata?.managed === true) {
          // Bring the service up (installing it again if it went missing) before comparing:
          // only a setup that is there can tell that the sign-in's key is no longer its own.
          const local = await ensureStudio({ proxy: opts.proxy });
          if (!sameBackend(c, local)) throw managedMismatch();
        }
        return {
          apiKey: c.key,
          baseURL: c.baseURL,
          fetch: (input, init) => forwardManagedStudio(input, init, getAuth, opts)
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return { error: 'AI Studio 还没有登录', windows: [], signIn: 'kept' };
        if (!auth.metadata?.managed) {
          return { error: '连接已有 AIStudio2API 时读不到本地账户状态（外部服务不提供管理接口）', windows: [], signIn: 'kept' };
        }
        let c;
        try {
          c = credentials(auth, opts);
        } catch (err) {
          return { error: err.message, windows: [], signIn: 'kept' };
        }
        const local = localStudio(opts);
        if (!local) {
          return { error: '本地 AI Studio 服务还没有装好，下一次请求时会自动安装', windows: [], signIn: 'kept' };
        }
        if (!sameBackend(c, local)) {
          return { error: '本地 AI Studio 配置不匹配，请重新登录', windows: [], signIn: 'expired' };
        }

        let accounts, cooldowns, proxy;
        try {
          [accounts, cooldowns, proxy] = await Promise.all([
            studioAdmin(local, 'GET', '/api/accounts', null, { timeoutMs: 3000 }),
            // Without its cooldowns or proxy the card still says whose accounts these are.
            studioAdmin(local, 'GET', '/api/cooldowns', null, { timeoutMs: 3000 }).catch(() => null),
            studioProxy(local, opts).catch(() => null)
          ]);
        } catch (err) {
          if (isConnectRefused(err)) {
            return { error: '本地 AI Studio 服务没有在运行，下一次请求时会自动启动', windows: [], signIn: 'kept' };
          }
          return { error: `无法读取本地 AI Studio 状态: ${err.message}`, windows: [], signIn: 'kept' };
        }
        const enabled = (Array.isArray(accounts?.accounts) ? accounts.accounts : []).filter(a => a && a.enabled !== false);
        const cooling = Array.isArray(cooldowns?.cooldowns) ? cooldowns.cooldowns : [];
        const id = auth.metadata.account;
        const service = serviceWindows(local, proxy);
        let card;
        if (typeof id !== 'string' || !id) {
          // A sign-in for the whole pool, as 0.5.0 made them
          card = poolUsage(enabled, cooling);
        } else {
          const account = enabled.find(a => a.id === id);
          card = account
            ? accountUsage(account, cooling)
            : { error: `本地 AI Studio 里已经没有这个账号（${auth.metadata.email || id}），可能被停用或删除了`, windows: [] };
        }
        return { ...card, windows: [...card.windows, ...service], signIn: 'kept' };
      }
    },
    provider: {
      id: STUDIO_ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        const c = credentials(auth, opts);
        if (auth.metadata?.managed === true) {
          const local = await ensureStudio({ proxy: opts.proxy });
          if (!sameBackend(c, local)) throw managedMismatch();
        }
        try {
          return await listStudioModels(c, opts);
        } catch (err) {
          if (!err.unreachable || !auth.metadata?.managed) throw err;
          await ensureStudio({ ...opts, proxy: opts.proxy });
          return listStudioModels(c, opts);
        }
      }
    }
  };
};

export default AIStudioPlugin;

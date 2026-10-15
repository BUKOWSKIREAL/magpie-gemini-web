import { citeStream, citeJSON } from './cite.mjs';

export const DEFAULT_BASE = 'http://127.0.0.1:8083/v1';

const MEDIA_SPECIAL = /(?:^|[-_])(image|music|canvas|video|research)(?:[-_]|$)/i;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const NEWLINE_CHARS = /[\r\n]/;

// The backend has no effort parameter: extended thinking is a separate "<id>-thinking" model.
// A base model with such a twin offers low (itself) and high (the twin), and the twin isn't
// listed on its own; a request that names it still goes through. Magpie maps any other level to
// the nearest declared one before it reaches us; direct callers get the same rule.
const THINKING_SUFFIX = '-thinking';
const LOW_EFFORTS = new Set(['none', 'minimal', 'low']);
const MODEL_CACHE_MS = 10 * 60 * 1000;
const knownModels = new Map();

// Set on the 502 forward() returns when the backend can't be reached at all, so a caller that
// manages the backend can start it and retry.
export const UNREACHABLE_HEADER = 'X-Gemini-Web-Backend';

const KNOWN_OPTIONS = new Set([
  'baseURL',
  'allowTools',
  'allowImages',
  'contextLimit',
  'outputLimit',
  'requestTimeoutMs',
  'modelTimeoutMs',
  'stripCitations'
]);

function makeOpenAIError(status, message, extraHeaders = {}) {
  const codeMap = {
    400: 'invalid_request_error',
    401: 'unauthorized',
    404: 'not_found',
    502: 'bad_gateway',
    504: 'gateway_timeout'
  };
  const body = JSON.stringify({
    error: {
      message,
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      param: null,
      code: codeMap[status] || null
    }
  });
  const headers = new Headers({
    'content-type': 'application/json',
    ...extraHeaders
  });
  if (status === 401) {
    headers.set('X-Magpie-Sign-In', 'expired');
  }
  return new Response(body, { status, headers });
}

export function normalizeBaseURL(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid base URL: must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Invalid base URL: must not be empty');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid base URL: malformed URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid base URL: protocol must be HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid base URL: credentials not allowed in URL');
  }
  if (parsed.search) {
    throw new Error('Invalid base URL: query parameters not allowed');
  }
  if (parsed.hash) {
    throw new Error('Invalid base URL: URL fragment not allowed');
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'http:' && !isLoopback) {
    throw new Error('Invalid base URL: HTTP only allowed for local loopback (localhost, 127.0.0.1, [::1]); remote must use HTTPS');
  }
  let pathname = parsed.pathname;
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === '/' || pathname === '') {
    pathname = '/v1';
  } else if (pathname === '/v1' || pathname.endsWith('/v1')) {
    // valid
  } else {
    throw new Error('Invalid base URL: path must end in /v1 or be root');
  }
  return `${parsed.origin}${pathname}`;
}

export function settings(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Plugin options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(key)) {
      throw new Error(`Unknown plugin option: ${key}`);
    }
  }

  let baseURL = DEFAULT_BASE;
  if (options.baseURL !== undefined) {
    baseURL = normalizeBaseURL(options.baseURL);
  }

  // On by default: coding agents send tools with every request and don't read toolcall,
  // so turning this off only means every one of their requests gets a 400.
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

  let contextLimit = 1000000;
  if (options.contextLimit !== undefined) {
    if (!Number.isInteger(options.contextLimit) || options.contextLimit <= 0) {
      throw new Error('Invalid option contextLimit: must be a positive integer');
    }
    contextLimit = options.contextLimit;
  }

  let outputLimit = 8192;
  if (options.outputLimit !== undefined) {
    if (!Number.isInteger(options.outputLimit) || options.outputLimit <= 0) {
      throw new Error('Invalid option outputLimit: must be a positive integer');
    }
    outputLimit = options.outputLimit;
  }

  if (outputLimit > contextLimit) {
    throw new Error('Invalid option outputLimit: cannot exceed contextLimit');
  }

  let requestTimeoutMs = 240000;
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

  // Gemini's citation markers come out of replies unless this is false: text that means them,
  // as code about them does, would lose them too.
  let stripCitations = true;
  if (options.stripCitations !== undefined) {
    if (typeof options.stripCitations !== 'boolean') {
      throw new Error('Invalid option stripCitations: must be a boolean');
    }
    stripCitations = options.stripCitations;
  }

  return {
    baseURL,
    allowTools,
    allowImages,
    contextLimit,
    outputLimit,
    requestTimeoutMs,
    modelTimeoutMs,
    stripCitations
  };
}

export function credentials(auth, opts) {
  if (!auth || typeof auth !== 'object' || auth.type !== 'api') {
    throw new Error('Invalid authentication: expected api type');
  }
  if (typeof auth.key !== 'string') {
    throw new Error('API key must be a string');
  }
  if (NEWLINE_CHARS.test(auth.key)) {
    throw new Error('API key must not contain newline characters');
  }
  const key = auth.key.trim();
  if (key.length === 0) {
    throw new Error('API key must not be empty');
  }

  let baseURL = opts?.baseURL || DEFAULT_BASE;
  const metaBase = auth.metadata?.baseURL;
  if (typeof metaBase === 'string' && metaBase.trim().length > 0) {
    baseURL = normalizeBaseURL(metaBase);
  }

  return { key, baseURL };
}

export async function listModels(c, opts) {
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
    const error = new Error('Failed to reach backend models endpoint: ' + (err?.message || err));
    error.status = 502;
    error.unreachable = true;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`Failed to list models: HTTP ${res.status}`);
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

  const seen = new Set();
  const validIds = [];

  for (const item of body.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
      throw new Error('Invalid model entry in response: expected object with string id');
    }
    const id = item.id;
    if (!id || CONTROL_CHARS.test(id)) {
      throw new Error('Invalid model entry in response: invalid id format');
    }
    if (!id.startsWith('gemini-')) {
      continue;
    }
    if (MEDIA_SPECIAL.test(id)) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    validIds.push(id);
  }

  if (validIds.length === 0) {
    throw new Error('No usable Gemini models found in backend response');
  }

  const ids = new Set(validIds);
  knownModels.set(modelCacheKey(c), { ids, at: Date.now() });

  const result = Object.create(null);
  for (const id of validIds) {
    if (id.endsWith(THINKING_SUFFIX) && ids.has(id.slice(0, -THINKING_SUFFIX.length))) continue;
    const hasTwin = !id.endsWith(THINKING_SUFFIX) && ids.has(id + THINKING_SUFFIX);
    result[id] = {
      id,
      providerID: 'gemini-web',
      name: id,
      api: {
        id,
        url: c.baseURL,
        npm: '@ai-sdk/openai-compatible'
      },
      limit: {
        context: opts.contextLimit,
        output: opts.outputLimit
      },
      capabilities: {
        temperature: false,
        reasoning: true,
        attachment: opts.allowImages,
        toolcall: opts.allowTools,
        input: {
          text: true,
          image: opts.allowImages
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
      variants: hasTwin ? { low: {}, high: {} } : {},
      status: 'active'
    };
  }

  return result;
}

function modelCacheKey(c) {
  return `${c.baseURL}\n${c.key}`;
}

// thinkingTwin returns the model a chat request should run on for its reasoning_effort, or null
// to leave it alone. The twin is only used when the backend lists it; if the list can't be
// fetched the request goes out unchanged.
async function thinkingTwin(body, c, opts) {
  const effort = body.reasoning_effort;
  const model = body.model;
  if (typeof effort !== 'string' || LOW_EFFORTS.has(effort)) return null;
  if (typeof model !== 'string' || model.endsWith(THINKING_SUFFIX)) return null;

  let cached = knownModels.get(modelCacheKey(c));
  if (!cached || Date.now() - cached.at > MODEL_CACHE_MS) {
    try {
      await listModels(c, opts);
    } catch {
      return null;
    }
    cached = knownModels.get(modelCacheKey(c));
  }
  const twin = model + THINKING_SUFFIX;
  return cached?.ids.has(twin) ? twin : null;
}

export async function forward(input, init, getAuth, opts) {
  const req = new Request(input, init);

  let auth;
  try {
    auth = await getAuth();
  } catch {
    return makeOpenAIError(401, 'Authentication loader failed');
  }

  if (!auth || auth.type !== 'api') {
    return makeOpenAIError(401, 'Unauthorized: backend API key required');
  }

  let c;
  try {
    c = credentials(auth, opts);
  } catch (err) {
    return makeOpenAIError(401, 'Unauthorized: ' + err.message);
  }

  let reqUrl;
  try {
    reqUrl = new URL(req.url);
  } catch {
    return makeOpenAIError(400, 'Invalid request URL');
  }

  if (reqUrl.search || reqUrl.hash) {
    return makeOpenAIError(400, 'Query parameters and fragments are not allowed');
  }

  const chatUrl = `${c.baseURL}/chat/completions`;
  const modelsUrl = `${c.baseURL}/models`;
  const incomingUrl = `${reqUrl.origin}${reqUrl.pathname}`;

  if (incomingUrl !== chatUrl && incomingUrl !== modelsUrl) {
    return makeOpenAIError(404, 'Endpoint not found');
  }

  if (incomingUrl === chatUrl && req.method !== 'POST') {
    return makeOpenAIError(400, 'Method not allowed: /chat/completions requires POST');
  }
  if (incomingUrl === modelsUrl && req.method !== 'GET') {
    return makeOpenAIError(400, 'Method not allowed: /models requires GET');
  }

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${c.key}`);
  const accept = req.headers.get('accept');
  if (accept) {
    headers.set('accept', accept);
  } else {
    headers.set('accept', 'application/json');
  }
  const contentType = req.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }

  let rawBody = null;
  if (incomingUrl === chatUrl) {
    try {
      rawBody = await req.text();
    } catch {
      return makeOpenAIError(400, 'Failed to read request body');
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return makeOpenAIError(400, 'Invalid JSON body');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return makeOpenAIError(400, 'Request body must be a JSON object');
    }

    const hasTools = (Array.isArray(body.tools) && body.tools.length > 0) ||
                     (Array.isArray(body.functions) && body.functions.length > 0);
    if (!opts.allowTools && hasTools) {
      return makeOpenAIError(400, `Tool calls are turned off for magpie-gemini-web. Turn them on with: magpie plugin options magpie-gemini-web '{"allowTools":true}'`);
    }

    if (body.messages !== undefined) {
      if (!Array.isArray(body.messages)) {
        return makeOpenAIError(400, 'messages must be an array');
      }
      for (const msg of body.messages) {
        if (!msg || typeof msg !== 'object') {
          return makeOpenAIError(400, 'Message entries must be objects');
        }
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part || typeof part !== 'object') {
              return makeOpenAIError(400, 'Message content parts must be objects');
            }
            if (part.type === 'text') {
              if (typeof part.text !== 'string') {
                return makeOpenAIError(400, 'Text content must contain a text string');
              }
            } else if (part.type === 'image_url') {
              if (!opts.allowImages) {
                return makeOpenAIError(400, `Image input is turned off for magpie-gemini-web. Turn it on with: magpie plugin options magpie-gemini-web '{"allowImages":true}'`);
              }
              if (!part.image_url || typeof part.image_url.url !== 'string' || !part.image_url.url.trim()) {
                return makeOpenAIError(400, 'Image content must contain an image_url URL');
              }
            } else {
              return makeOpenAIError(400, 'Unsupported content type; only text and image_url are supported');
            }
          }
        } else if (msg.content !== null && msg.content !== undefined && typeof msg.content !== 'string') {
          return makeOpenAIError(400, 'Message content must be string or array of parts');
        }
      }
    }

    const twin = await thinkingTwin(body, c, opts);
    if (twin) {
      body.model = twin;
      rawBody = JSON.stringify(body);
    }
  }

  const timeoutSignal = AbortSignal.timeout(opts.requestTimeoutMs);
  const signal = AbortSignal.any([req.signal, timeoutSignal]);

  let upstreamRes;
  try {
    upstreamRes = await fetch(incomingUrl, {
      method: req.method,
      headers,
      body: rawBody,
      signal,
      redirect: 'error'
    });
  } catch (err) {
    if (req.signal.aborted) {
      throw req.signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    }
    if (timeoutSignal.aborted || err?.name === 'TimeoutError') {
      return makeOpenAIError(504, 'Gateway timeout: backend request timed out');
    }
    if (err?.name === 'AbortError') {
      throw err;
    }
    return makeOpenAIError(502, 'Bad gateway: failed to reach backend service', { [UNREACHABLE_HEADER]: 'unreachable' });
  }

  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  if (upstreamRes.status === 401) {
    respHeaders.set('X-Magpie-Sign-In', 'expired');
  }

  // Gemini's citation markers come out of a chat reply, streamed or whole (see cite.mjs).
  let respBody = upstreamRes.body;
  if (opts.stripCitations && incomingUrl === chatUrl && upstreamRes.ok && respBody) {
    const type = upstreamRes.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) respBody = citeStream(respBody);
    else if (type.includes('json')) respBody = citeJSON(await upstreamRes.text());
  }

  return new Response(respBody, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders
  });
}

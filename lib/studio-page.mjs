import http from 'node:http';
import crypto from 'node:crypto';

// A page closes this long after it opened even when nothing closes it: longer than a sign-in can
// take (a download, the service's start, the login's 15 minutes).
const PAGE_LIFETIME_MS = 40 * 60 * 1000;

// openProgressPage serves a sign-in's progress as a page of its own on 127.0.0.1, at a path no
// other page can guess. read() is what it shows, which it asks for every second:
//   { title, note, steps: [{ label, state, detail, received, total }], done, error }
// with state 'pending', 'active', 'done' or 'failed', and received and total in bytes (total 0
// while not known) for a step that downloads. It stops at close(), or at PAGE_LIFETIME_MS.
export async function openProgressPage(read) {
  const token = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  let host = '';
  const server = http.createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    // the Host a rebound DNS name sends can't reach it either
    if (req.method !== 'GET' || req.headers.host !== host) {
      res.writeHead(404, headers).end();
      return;
    }
    if (req.url === `/${token}`) {
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      }).end(PAGE.replace('NONCE', nonce));
      return;
    }
    if (req.url === `/${token}/status`) {
      let body;
      try {
        body = JSON.stringify(read());
      } catch (err) {
        res.writeHead(500, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404, headers).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  host = `127.0.0.1:${server.address().port}`;
  const timer = setTimeout(close, PAGE_LIFETIME_MS);
  timer.unref();
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
  return { url: `http://${host}/${token}`, close };
}

// PAGE draws what the status says, as text only (nothing in it is read as HTML).
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google AI Studio 登录进度</title>
<style>
:root { color-scheme: light dark; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --bar: #2f6feb; --ok: #1a7f37; --bad: #cf222e; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --bar: #4c8dff; --ok: #3fb950; --bad: #f85149; --bg: #0d1117; } }
body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--fg); background: var(--bg); max-width: 640px; margin: 48px auto; padding: 0 20px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.note { color: var(--muted); margin: 0 0 24px; }
ol { list-style: none; padding: 0; margin: 0; }
li { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
li.pending { opacity: .55; }
li.failed { border-color: var(--bad); }
.head { display: flex; gap: 10px; align-items: center; font-weight: 600; }
.mark { width: 20px; flex: none; text-align: center; }
li.done .mark { color: var(--ok); }
li.failed .mark { color: var(--bad); }
.spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--bar); border-right-color: transparent; border-radius: 50%; animation: turn .8s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
.detail { color: var(--muted); font-size: 13px; margin: 4px 0 0 30px; white-space: pre-wrap; }
.track { height: 8px; border-radius: 4px; background: var(--line); margin: 8px 0 0 30px; overflow: hidden; }
.fill { height: 100%; background: var(--bar); transition: width .4s; }
.track.unknown .fill { width: 30%; animation: slide 1.2s linear infinite; }
@keyframes slide { from { margin-left: -30%; } to { margin-left: 100%; } }
.end { margin-top: 20px; font-weight: 600; white-space: pre-wrap; }
.end.ok { color: var(--ok); }
.end.bad { color: var(--bad); }
</style>
</head>
<body>
<h1 id="title">Google AI Studio 登录进度</h1>
<p class="note" id="note"></p>
<ol id="steps"></ol>
<p class="end" id="end"></p>
<script nonce="NONCE">
const STATUS = location.pathname + '/status';
const MARKS = { pending: '○', done: '✓', failed: '✕' };
const mb = n => (n / 1048576).toFixed(1);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function render(s) {
  if (s.title) document.getElementById('title').textContent = s.title;
  document.getElementById('note').textContent = s.note || '';
  const list = document.getElementById('steps');
  list.replaceChildren(...(s.steps || []).map(step => {
    const li = el('li', step.state);
    const mark = el('span', 'mark');
    if (step.state === 'active') mark.append(el('span', 'spin'));
    else mark.textContent = MARKS[step.state] || '';
    const head = el('div', 'head');
    head.append(mark, el('span', '', step.label));
    li.append(head);
    let detail = step.detail || '';
    const downloading = step.state === 'active' && typeof step.received === 'number';
    if (downloading) {
      const pct = step.total ? Math.min(100, Math.floor(step.received * 100 / step.total)) : 0;
      const got = step.total ? '已下载 ' + mb(step.received) + ' / ' + mb(step.total) + ' MB（' + pct + '%）'
        : step.received ? '已下载 ' + mb(step.received) + ' MB' : '';
      detail = [detail, got].filter(Boolean).join('：');
    }
    if (detail) li.append(el('div', 'detail', detail));
    if (downloading) {
      const track = el('div', step.total ? 'track' : 'track unknown');
      const fill = el('div', 'fill');
      if (step.total) fill.style.width = Math.min(100, step.received * 100 / step.total) + '%';
      track.append(fill);
      li.append(track);
    }
    return li;
  }));
  const end = document.getElementById('end');
  if (s.error) {
    end.className = 'end bad';
    end.textContent = s.error;
  } else if (s.done) {
    end.className = 'end ok';
    end.textContent = s.doneText || '完成了，可以关掉这个页面。';
  }
}

let misses = 0;
async function poll() {
  try {
    const res = await fetch(STATUS, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();
    misses = 0;
    render(s);
    if (s.done || s.error) return;
  } catch {
    if (++misses >= 3) {
      const end = document.getElementById('end');
      if (!end.textContent) end.textContent = '这个页面已经停止更新，请回到 Magpie 查看结果。';
      return;
    }
  }
  setTimeout(poll, 1000);
}
poll();
</script>
</body>
</html>
`;

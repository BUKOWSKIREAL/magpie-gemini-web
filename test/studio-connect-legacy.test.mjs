import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { openStudioConnect } from '../lib/studio-connect-legacy.mjs';

const ready = { id: 'one@example.invalid', label: 'One', enabled: true, state: 'ready' };
async function fixture(options = {}) {
  let accounts = [ready], offline = false, beforeAccounts;
  const local = { origin: 'http://127.0.0.1:2048', apiKey: 'private-key', adminUsername: 'private-admin', adminPassword: 'private-password' };
  const requests = [];
  const page = await openStudioConnect({
    prepare: async () => local, deadline: Date.now() + 10000, ...options,
    fetchFn: async (url, init) => {
      const route = new URL(url).pathname;
      requests.push({ route, method: init.method });
      if (route === '/api/auth/login') return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=test-session; Path=/api; HttpOnly' } });
      assert.equal(route, '/api/accounts');
      assert.equal(new Headers(init.headers).get('Cookie'), 'aistudio_admin=test-session');
      await beforeAccounts?.();
      if (offline) throw new Error('temporary backend outage');
      return Response.json({ accounts });
    }
  });
  const result = page.start();
  const origin = new URL(page.url).origin;
  const request = (route, init = {}) => fetch(new URL(route, page.url), {
    ...init, headers: { ...init.headers, Origin: origin }
  });
  await request(page.url + '/status');
  return { page, result, requests, request, setAccounts: value => { accounts = value; }, setOffline: value => { offline = value; }, beforeAccounts: fn => { beforeAccounts = fn; } };
}

// Run the shipped page script against its real HTTP bridge. The small DOM adapter only
// implements form controls; these tests do not replace a real browser/rendering check.
async function pageScript(f) {
  const html = await (await fetch(f.page.url)).text();
  const elements = new Map();
  const timers = [];
  function element(tag, attrs = '') {
    let value = '';
    return {
      tag, disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs), textContent: '', className: '', children: [],
      get value() { return tag === 'select' && !this.children.some(child => child.value === value) ? '' : value; },
      set value(next) { value = next; },
      get selectedOptions() { return this.children.filter(child => child.value === this.value).slice(0, 1); },
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); }
    };
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[3], element(match[1], match[2]));
  const window = { open: () => null };
  await vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => elements.get(id) ?? null, createElement: tag => element(tag) },
    location: { pathname: new URL(f.page.url).pathname },
    fetch: f.request, window, setTimeout: fn => { timers.push(fn); }
  });
  return { get: id => elements.get(id), window, poll: async () => { assert.ok(timers.length); await timers.shift()(); } };
}

describe('Official connection page user journeys', () => {
  it('recovers from a transient outage without leaving an error or accepting stale account data', async () => {
    const f = await fixture();
    try {
      const ui = await pageScript(f);
      ui.get('account').value = ready.id;
      ui.get('account').onchange();
      assert.equal(ui.get('submit').disabled, false);
      f.setOffline(true);
      await ui.poll();
      assert.match(ui.get('message').textContent, /暂时无法读取账号/);
      assert.equal(ui.get('submit').disabled, true);
      ui.get('account').onchange();
      assert.equal(ui.get('submit').disabled, true);
      f.setOffline(false);
      await ui.poll();
      assert.equal(ui.get('message').textContent, '');
      assert.equal(ui.get('account').value, ready.id);
      assert.equal(ui.get('submit').disabled, false);
      await ui.get('submit').onclick();
      assert.equal((await f.result).account.id, ready.id);
      assert.match(ui.get('message').textContent, /连接完成/);
    } finally { f.page.close(); }
  });

  it('clears a blocked-popup warning when management opens on retry', async () => {
    const f = await fixture();
    try {
      const ui = await pageScript(f);
      await ui.get('manage').onclick();
      assert.match(ui.get('message').textContent, /浏览器阻止/);
      await ui.poll();
      assert.match(ui.get('message').textContent, /浏览器阻止/, 'healthy polling keeps actionable warnings');
      let destination;
      const popup = { opener: {}, location: { replace: value => { destination = value; } }, close() {} };
      ui.window.open = () => popup;
      await ui.get('manage').onclick();
      assert.equal(destination, 'http://127.0.0.1:2048/?tab=accounts');
      assert.equal(popup.opener, null);
      assert.equal(ui.get('message').textContent, '');
    } finally { f.page.close(); }
  });

  it('keeps the cancellation result when a pending selection finishes later', async () => {
    const f = await fixture();
    let release;
    try {
      const ui = await pageScript(f);
      ui.get('account').value = ready.id;
      ui.get('account').onchange();
      let entered;
      const reading = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      f.beforeAccounts(async () => { entered(); await gate; });
      const selecting = ui.get('submit').onclick();
      await reading;
      await ui.get('cancel').onclick();
      const message = ui.get('message').textContent;
      assert.match(message, /已取消登录/);
      release();
      await selecting;
      assert.equal(ui.get('message').textContent, message);
      assert.equal(ui.get('submit').disabled, true);
      await assert.rejects(f.result, /取消/);
    } finally { release?.(); f.page.close(); }
  });

  it('guides expired accounts to re-login and cannot connect a different account', async () => {
    const f = await fixture({ accountId: ready.id });
    try {
      f.setAccounts([{ ...ready, state: 'auth_required' }, { ...ready, id: 'other@example.invalid' }]);
      const ui = await pageScript(f);
      assert.match(ui.get('detail').textContent, /one@example.invalid.*重新登录/);
      assert.match(ui.get('account-step')?.textContent || '', /重新登录原账号/);
      assert.equal(ui.get('account').children.length, 2);
      assert.equal(ui.get('account').children[1].disabled, true);
      const forged = await f.request(f.page.url + '/select', { method: 'POST', body: JSON.stringify({ id: 'other@example.invalid' }) });
      assert.equal(forged.status, 409);
      f.setAccounts([ready]);
      await ui.poll();
      ui.get('account').value = ready.id;
      ui.get('account').onchange();
      await ui.get('submit').onclick();
      assert.equal((await f.result).account.id, ready.id);
    } finally { f.page.close(); }
  });
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

function documentFixture() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', dataset: {}, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  };
  return { get, document: { getElementById: get, querySelectorAll: () => [], addEventListener() {}, hidden: false } };
}
const source = file => fs.readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

it('console renders the initial null operation and preserves unfinished proxy edits on refresh', async () => {
  const { get, document } = documentFixture();
  const requests = [];
  const storage = new Map();
  let removedFragment = false;
  const state = { backend: { status: 'running', ready: true, accounts: { total: 1, ready: 1, busy: 0 } }, proxy: { active: 'http://localhost:9393', source: 'startup', pending: 'restart' }, savedProxy: 'http://localhost:7890', savedDisplay: 'http://localhost:7890', paused: false, operation: null };
  vm.runInNewContext(source('console.js'), {
    document, location: { hash: '#fixture-token' }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    history: { replaceState: () => { removedFragment = true; } }, AbortSignal, setInterval() {},
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => structuredClone(state) }; }
  });
  await settle();
  assert.equal(get('backend').textContent, '运行中');
  assert.equal(get('proxy-url').value, state.savedProxy);
  assert.equal(get('message').dataset.error, 'false');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(removedFragment, true);
  get('proxy-url').value = 'http://localhost:8888';
  get('proxy-url').handlers.input();
  get('refresh').handlers.click();
  await settle();
  assert.equal(get('proxy-url').value, 'http://localhost:8888');
  assert.equal(requests.length, 2);
});

it('sandbox entry preserves unrelated options and submits only a console-open request', async () => {
  const { get, document } = documentFixture();
  let written;
  const options = { allowImages: true, studio: { allowTools: false } };
  await vm.runInNewContext(source('app.js'), { document, crypto, setTimeout: fn => fn(), magpie: {
    ready: Promise.resolve(), options: { get: async () => structuredClone(options), set: async value => { written = value; } }
  } });
  assert.equal(get('open').disabled, false);
  await get('open').handlers.click();
  assert.equal(written.allowImages, true);
  assert.equal(written.studio.allowTools, false);
  assert.equal(written.studio.localConsole, true);
  assert.match(written.studio.consoleOpen.id, /^[a-f0-9]{32}$/);
  assert.equal(Object.keys(written.studio).some(key => ['command', 'start', 'stop', 'proxy'].includes(key)), false);
});

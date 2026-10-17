// Opt-in live acceptance probe. Sends synthetic prompts to the local Magpie gateway.
// Never run by npm test; never executes a model-requested tool or shell command.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { localStudio, studioAdmin, stopStudio } from '../lib/studio-native.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[i + 1];
}
const gateway = new URL(option('--gateway', 'http://127.0.0.1:3425/v1'));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname), 'live probe requires a local gateway');
assert.ok(['http:', 'https:'].includes(gateway.protocol));
assert.ok(!gateway.username && !gateway.password && !gateway.search && !gateway.hash);
const base = gateway.href.replace(/\/$/, '');
const model = option('--model', 'ai-studio/gemini-4-argon');
assert.ok(model.startsWith('ai-studio/'), 'only the AI Studio provider may be tested');
const outputDir = path.resolve(option('--out', 'evidence/studio-acceptance'));
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const resultPath = path.join(outputDir, 'results.json');
const headers = { 'Content-Type': 'application/json', ...(process.env.MAGPIE_GATEWAY_KEY ? { Authorization: `Bearer ${process.env.MAGPIE_GATEWAY_KEY}` } : {}) };
const report = { startedAt: new Date().toISOString(), gateway: base, model, checks: [], status: 'running', requestCount: 0 };
const local = localStudio();
assert.ok(local, 'install and sign in to the managed AI Studio backend first');
function save() { fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
async function check(name, fn) {
  const start = performance.now();
  try {
    const evidence = await fn();
    report.checks.push({ name, status: 'pass', elapsedMs: Math.round(performance.now() - start), ...evidence });
    console.log(`PASS ${name}`); save(); return evidence;
  } catch (error) {
    report.checks.push({ name, status: 'fail', elapsedMs: Math.round(performance.now() - start), error: String(error.message).slice(0, 2000) });
    console.error(`FAIL ${name}: ${String(error.message).slice(0, 1000)}`); save(); throw error;
  }
}
function browserProcesses() {
  if (process.platform === 'win32') return null;
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').filter(l => /camoufox|firefox/i.test(l));
}
async function chat(payload, options = {}) {
  report.requestCount++;
  const started = performance.now();
  const signal = options.signal || AbortSignal.timeout(180000);
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, ...payload }), signal, redirect: 'error' });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${response.ok ? '' : (await response.text()).slice(0, 1500)}`);
  if (!payload.stream) {
    const body = await response.json();
    assert.ok(!body.error, JSON.stringify(body.error));
    return { id: body.id, content: body.choices?.[0]?.message?.content ?? '', finish: body.choices?.[0]?.finish_reason, elapsedMs: Math.round(performance.now() - started) };
  }
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', content = '', finish = null, id, done = false, contentMs = null, chunkCount = 0;
  const calls = new Map();
  function parse() {
    pending = pending.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { done = true; continue; }
      const c = JSON.parse(data);
      assert.ok(!c.error, JSON.stringify(c.error));
      id = c.id ?? id;
      const choice = c.choices?.find(choice => choice.index === 0);
      if (!choice) continue;
      chunkCount++;
      const delta = choice.delta ?? {};
      if (delta.content || delta.tool_calls?.length) contentMs ??= Math.round(performance.now() - started);
      content += delta.content ?? '';
      finish = choice.finish_reason ?? finish;
      for (const t of delta.tool_calls ?? []) {
        const prior = calls.get(t.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) prior.id = t.id;
        if (t.function?.name) prior.function.name += t.function.name;
        if (t.function?.arguments) prior.function.arguments += t.function.arguments;
        if (t.extra_content) prior.extra_content = t.extra_content;
        calls.set(t.index, prior);
      }
    }
  }
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      pending += decoder.decode(r.value, { stream: true }); parse();
    }
    pending += decoder.decode(); parse();
    assert.ok(done, 'missing SSE [DONE]');
    return { id, content, finish, calls: [...calls.values()], firstContentOrToolMs: contentMs, chunkCount, elapsedMs: Math.round(performance.now() - started) };
  } finally { await reader.cancel().catch(() => {}); }
}
const tools = [
  { type: 'function', function: { name: 'read_probe', description: 'Return the token for a synthetic test key.', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['first'] } }, required: ['key'], additionalProperties: false } } },
  { type: 'function', function: { name: 'verify_probe', description: 'Return a receipt for the exact token from read_probe.', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } } },
];
const messages = [{ role: 'user', content: 'First call read_probe with key first. Then call verify_probe using the exact token returned by read_probe. After verify_probe returns, reply with its receipt exactly, with no formatting or extra text. Preserve every character of the receipt, including brackets.' }];
// Deliberately simulate an OpenAI client/SDK that drops provider extension fields.
function clientCall(t) { return { id: t.id, type: 'function', function: { ...t.function } }; }
function toolEvidence(out, name, expected) {
  assert.equal(out.calls.length, 1);
  const call = out.calls[0];
  assert.ok(call.id); assert.equal(call.function.name, name);
  assert.deepEqual(JSON.parse(call.function.arguments), expected);
  assert.equal(out.finish, 'tool_calls');
  return { requestId: out.id, function: name, arguments: expected, signatureExposedByGateway: !!call.extra_content?.google?.thought_signature, firstContentOrToolMs: out.firstContentOrToolMs, elapsedMs: out.elapsedMs };
}
try {
  await check('Go backend ready without a login browser', async () => {
    const state = await studioAdmin(local, 'GET', '/api/status');
    assert.equal(state.ready, true); assert.ok(state.accounts.total >= 1);
    const browsers = browserProcesses(); if (browsers) assert.equal(browsers.length, 0);
    return { state: state.state, readyAccounts: state.accounts.ready, browserProcesses: browsers };
  });
  await check('first native tool call through Magpie, medium effort', async () => {
    const out = await chat({ messages, tools, tool_choice: { type: 'function', function: { name: 'read_probe' } }, reasoning_effort: 'medium', stream: true });
    const evidence = toolEvidence(out, 'read_probe', { key: 'first' });
    messages.push({ role: 'assistant', content: out.content || null, tool_calls: out.calls.map(clientCall) }, { role: 'tool', tool_call_id: out.calls[0].id, content: '{"token":"studio-token-8214"}' });
    return evidence;
  });
  await check('second tool call uses first result without echoed signature', async () => {
    const out = await chat({ messages, tools, tool_choice: { type: 'function', function: { name: 'verify_probe' } }, reasoning_effort: 'medium', stream: true });
    const evidence = toolEvidence(out, 'verify_probe', { token: 'studio-token-8214' });
    messages.push({ role: 'assistant', content: out.content || null, tool_calls: out.calls.map(clientCall) }, { role: 'tool', tool_call_id: out.calls[0].id, content: '{"receipt":"STUDIO_CITATION_[cite: 1]_8214"}' });
    return evidence;
  });
  await check('tool continuation preserves literal citation text', async () => {
    const out = await chat({ messages, tools, tool_choice: 'none', reasoning_effort: 'medium', stream: true });
    assert.equal(out.content.trim(), 'STUDIO_CITATION_[cite: 1]_8214'); assert.equal(out.finish, 'stop');
    assert.equal(out.calls.length, 0); messages.push({ role: 'assistant', content: out.content });
    return { requestId: out.id, content: out.content, firstContentOrToolMs: out.firstContentOrToolMs, elapsedMs: out.elapsedMs };
  });
  await check('next user turn retains both tool results', async () => {
    const out = await chat({ messages: [...messages, { role: 'user', content: 'Reply with the token returned by read_probe, then a vertical bar, then the receipt returned by verify_probe. Preserve all characters; no extra text or spaces around the vertical bar.' }], stream: false });
    assert.equal(out.content.trim(), 'studio-token-8214|STUDIO_CITATION_[cite: 1]_8214');
    return { requestId: out.id, content: out.content, elapsedMs: out.elapsedMs };
  });
  await check('cancel an active Magpie request', async () => {
    const controller = new AbortController();
    let rejected = false, sawActive = false, requestError;
    const pending = chat({ messages: [{ role: 'user', content: 'Write a numbered list of the integers 1 through 2000, with each integer written also as an English word. Continue until the whole list is complete.' }], stream: true, reasoning_effort: 'medium' }, { signal: controller.signal }).catch(error => { if (!controller.signal.aborted) requestError = error; else rejected = true; });
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await studioAdmin(local, 'GET', '/api/status');
        if (state.active_requests > 0) { sawActive = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } finally { controller.abort(new DOMException('Acceptance probe cancellation', 'AbortError')); }
    await pending; if (requestError) throw requestError;
    assert.ok(sawActive, 'request never became active in Studio'); assert.ok(rejected, 'client did not observe cancellation');
    const deadline = Date.now() + 15000;
    let active;
    do {
      active = (await studioAdmin(local, 'GET', '/api/status')).active_requests;
      if (!active) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    assert.equal(active, 0, 'cancelled request still occupies upstream slot');
    return { sawActive, clientAborted: rejected, activeAfterCancellation: active };
  });
  await check('request succeeds after cancellation', async () => {
    const out = await chat({ messages: [{ role: 'user', content: 'Reply with exactly STUDIO_AFTER_CANCEL_8214 and nothing else.' }], stream: false });
    assert.equal(out.content.trim(), 'STUDIO_AFTER_CANCEL_8214');
    return { requestId: out.id, content: out.content, elapsedMs: out.elapsedMs };
  });
  await check('same Magpie sign-in resumes tool history after backend restart', async () => {
    const pidPath = path.join(local.dataDir, 'backend.pid');
    const before = Number(fs.readFileSync(pidPath, 'utf8').trim());
    assert.ok(Number.isInteger(before) && before > 0);
    await stopStudio();
    const out = await chat({ messages: [...messages, { role: 'user', content: 'Reply with the token returned by read_probe, then a vertical bar, then the receipt returned by verify_probe. Preserve all characters; no extra text or spaces around the vertical bar.' }], stream: false });
    assert.equal(out.content.trim(), 'studio-token-8214|STUDIO_CITATION_[cite: 1]_8214');
    const after = Number(fs.readFileSync(pidPath, 'utf8').trim());
    assert.ok(Number.isInteger(after) && after > 0); assert.notEqual(after, before);
    const state = await studioAdmin(local, 'GET', '/api/status');
    assert.equal(state.ready, true);
    return { requestId: out.id, content: out.content, elapsedMs: out.elapsedMs, previousPid: before, currentPid: after, ready: state.ready };
  });
  await check('no login browser after gateway acceptance', async () => {
    const browsers = browserProcesses(); if (browsers) assert.equal(browsers.length, 0);
    return { browserProcesses: browsers };
  });
  report.status = 'pass';
} catch (error) {
  report.status = 'failed'; report.error = String(error.message).slice(0, 2000); process.exitCode = 1;
} finally { report.finishedAt = new Date().toISOString(); save(); console.log(`RESULT ${report.status} ${resultPath}`); }

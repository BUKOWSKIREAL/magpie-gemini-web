import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openProgressPage } from '../lib/studio-page.mjs';

// get asks the page's server for path with the Host header given, as fetch can't set it.
function get(url, path, host) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path, agent: false, headers: { host: host ?? u.host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

describe('Sign-in progress page', () => {
  it('shows the status at its own path on 127.0.0.1, and nothing elsewhere', async () => {
    let state = { steps: [{ label: '准备本地 AI Studio 服务', state: 'active', detail: '正在下载', received: 1, total: 2 }], done: false, error: '' };
    const page = await openProgressPage(() => state);
    try {
      assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      const token = new URL(page.url).pathname;

      const html = await get(page.url, token);
      assert.equal(html.status, 200);
      assert.match(html.headers['content-type'], /^text\/html/);
      // its one script runs by the nonce the policy names
      const nonce = html.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
      assert.ok(html.body.includes(`<script nonce="${nonce}">`));

      assert.deepEqual(JSON.parse((await get(page.url, `${token}/status`)).body), state);
      state = { ...state, done: true };
      assert.equal(JSON.parse((await get(page.url, `${token}/status`)).body).done, true, 'each read is the status now');

      assert.equal((await get(page.url, '/')).status, 404);
      assert.equal((await get(page.url, `${token}x`)).status, 404);
      // A page that reached it by a rebound DNS name sends that name as its Host
      assert.equal((await get(page.url, token, 'attacker.example')).status, 404);
    } finally {
      page.close();
    }
    await assert.rejects(get(page.url, '/'), /ECONNREFUSED/, 'closed');
  });

  it('says why when the status can\'t be read', async () => {
    const page = await openProgressPage(() => { throw new Error('no status'); });
    try {
      const res = await get(page.url, `${new URL(page.url).pathname}/status`);
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), { error: 'no status' });
    } finally {
      page.close();
    }
  });
});

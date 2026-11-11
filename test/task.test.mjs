import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiWebPlugin } from '../index.mjs';

describe('retired macOS Task sign-in', () => {
  const auth = {
    type: 'api',
    key: 'task_key_0123456789abcdef',
    metadata: { mode: 'task', baseURL: 'http://127.0.0.1:9/v1' }
  };

  it('is not offered and is not sent to the Gemini Web backend', async () => {
    const plugin = await GeminiWebPlugin({});
    assert.equal(plugin.auth.methods.some(method => /Task|原生/.test(method.label)), false);
    assert.equal(plugin['chat.headers'], undefined);

    await assert.rejects(plugin.auth.loader(async () => auth), /已停用/);
    await assert.rejects(plugin.provider.models({ models: {} }, { auth }), /已停用/);
    const card = await plugin.auth.usage(async () => auth);
    assert.match(card.error, /已停用/);
    assert.equal(card.signIn, 'expired');
  });
});

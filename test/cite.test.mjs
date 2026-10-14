import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stripCites, CiteFilter, citeStream, citeJSON } from '../lib/cite.mjs';
import { forward, settings } from '../lib/backend.mjs';

const REPLY = '已将网页保存到本地，并在默认浏览器中打开了预览[cite: 1]：\n\n- **路径**：`/tmp/a.html` [cite: 1, 2]\n- [cite_start]按钮可随时切换[cite: 3]。';
const CLEAN = '已将网页保存到本地，并在默认浏览器中打开了预览：\n\n- **路径**：`/tmp/a.html`\n- 按钮可随时切换。';

function chunk(delta, extra = {}) {
  return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gemini-4-argon', choices: [{ index: 0, delta, ...extra }] };
}

function sse(events) {
  return events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}

// streamOf is a body giving text in pieces of the given sizes, the last one taking the rest.
function streamOf(text, sizes) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      let at = 0;
      for (const n of sizes) {
        if (at >= bytes.length) break;
        controller.enqueue(bytes.slice(at, at + n));
        at += n;
      }
      if (at < bytes.length) controller.enqueue(bytes.slice(at));
      controller.close();
    }
  });
}

async function readEvents(body) {
  const text = await new Response(body).text();
  // an SSE comment goes on as it came, kept as its text
  return text.split('\n\n').filter(Boolean).map(e => (e.startsWith(':') ? e : e.replace(/^data: /, '')))
    .map(d => (d === '[DONE]' || d.startsWith(':') ? d : JSON.parse(d)));
}

const joined = (events, pick) => events.filter(e => typeof e === 'object').map(pick).filter(v => v !== undefined).join('');

describe('29. Gemini citation markers are taken out of replies', () => {
  it('strips [cite: n], [cite: n, m], [cite_start] and [cite_end], with the blanks before a [cite: n]', () => {
    assert.equal(stripCites(REPLY), CLEAN);
    assert.equal(stripCites('a[cite:12]b [cite_end]c'), 'ab c');
    assert.equal(stripCites('see [1] and [citation] and [cite: x]'), 'see [1] and [citation] and [cite: x]');
    assert.equal(stripCites(null), null);
  });

  it('strips markers split across streamed pieces at every point', () => {
    for (let cut = 0; cut <= REPLY.length; cut++) {
      for (let cut2 = cut; cut2 <= REPLY.length; cut2 += 7) {
        const f = new CiteFilter();
        const out = f.push(REPLY.slice(0, cut)) + f.push(REPLY.slice(cut, cut2)) + f.push(REPLY.slice(cut2)) + f.flush();
        assert.equal(out, CLEAN, `cut at ${cut} and ${cut2}`);
      }
    }
  });

  it('gives back an unfinished marker-looking end when the stream stops', () => {
    const f = new CiteFilter();
    assert.equal(f.push('array[ci'), 'array');
    assert.equal(f.flush(), '[ci');
    assert.equal(f.push('x[') + f.push('0]'), 'x[0]');
  });

  it('strips an SSE stream, the markers split across events and bytes, and keeps other events', async () => {
    const pieces = ['已将网页保存', '到本地，并在默认浏览器中打开了预览[ci', 'te: 1]：\n\n- **路径**：`/tmp/a.html` [', 'cite: 1, 2]\n- [cite_', 'start]按钮可随时切换[cite: 3', ']。'];
    const text = sse([
      chunk({ role: 'assistant', reasoning_content: '想一想[cite: 1]' }),
      ...pieces.map(p => chunk({ content: p })),
      chunk({ tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'write', arguments: '{"text":"hi[cite' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ': 1]"}' } }] }),
      { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 3 } },
      '[DONE]'
    ]) + ': keep-alive\n\n';
    for (const sizes of [[text.length], [1, 2, 3, 5, 8, 13, 21, 34, 55, 89], Array(400).fill(3)]) {
      const events = await readEvents(citeStream(streamOf(text, sizes)));
      assert.equal(joined(events, e => e.choices?.[0]?.delta?.content), CLEAN);
      assert.equal(joined(events, e => e.choices?.[0]?.delta?.reasoning_content), '想一想');
      assert.equal(joined(events, e => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments), '{"text":"hi"}');
      assert.equal(events.find(e => e?.usage)?.usage.total_tokens, 3);
      assert.deepEqual(events.slice(-2), ['[DONE]', ': keep-alive']);
    }
  });

  it('puts what it holds in the chunk that finishes the choice, not after it', async () => {
    const text = sse([
      chunk({ content: 'see a[ci' }),
      chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: 'w', arguments: '{"x":"[' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      '[DONE]'
    ]);
    const events = await readEvents(citeStream(streamOf(text, [text.length])));
    const finish = events.findIndex(e => e?.choices?.[0]?.finish_reason);
    assert.equal(finish, events.length - 2);
    assert.equal(events[finish].choices[0].delta.content, '[ci');
    assert.equal(events[finish].choices[0].delta.tool_calls[0].function.arguments, '[');
    assert.equal(joined(events, e => e.choices?.[0]?.delta?.content), 'see a[ci');
  });

  it('sends what it holds when a stream ends without a finish', async () => {
    const events = await readEvents(citeStream(streamOf(sse([chunk({ content: 'x = a[ci' })]), [5])));
    assert.equal(joined(events, e => e.choices?.[0]?.delta?.content), 'x = a[ci');
  });

  it('strips a whole reply and leaves what is not JSON alone', () => {
    const body = JSON.parse(citeJSON(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY, reasoning_content: 'r[cite: 2]', tool_calls: [{ function: { name: 'w', arguments: '{"a":"b[cite: 1]"}' } }] } }]
    })));
    assert.equal(body.choices[0].message.content, CLEAN);
    assert.equal(body.choices[0].message.reasoning_content, 'r');
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"a":"b"}');
    assert.equal(citeJSON('not json [cite: 1]'), 'not json [cite: 1]');
  });

  describe('through forward()', () => {
    let server;
    let handler;
    let baseURL;

    before(async () => {
      server = http.createServer((req, res) => handler(req, res));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    });

    after(() => new Promise(resolve => server.close(resolve)));

    const ask = (stream, options = {}) => forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-4-argon', stream, messages: [{ role: 'user', content: 'hi' }] })
    }, async () => ({ type: 'api', key: 'k', metadata: { baseURL } }), settings({ baseURL, ...options }));

    it('strips a streamed and a whole reply, and leaves an error as it came', async () => {
      handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse([chunk({ content: 'done[ci' })]));
        setTimeout(() => res.end(sse([chunk({ content: 'te: 1].' }, { finish_reason: 'stop' }), '[DONE]'])), 10);
      };
      const streamed = await readEvents((await ask(true)).body);
      assert.equal(joined(streamed, e => e.choices?.[0]?.delta?.content), 'done.');

      handler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok[cite: 1]' } }] }));
      };
      assert.equal((await (await ask(false)).json()).choices[0].message.content, 'ok');
      assert.equal((await (await ask(false, { stripCitations: false })).json()).choices[0].message.content, 'ok[cite: 1]');

      handler = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"x [cite: 1]"}}');
      };
      const failed = await ask(false);
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), '{"error":{"message":"x [cite: 1]"}}');
    });
  });
});

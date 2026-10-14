// Gemini's web app marks the sentences it grounds in a source with [cite_start] … [cite: 1, 2],
// which its page turns into citation chips. The backend hands the raw text on, so an agent's
// replies, and the files its tools write, fill with them; the context an agent sends counts as
// the source. They are taken out of every chat completion here, streamed or whole.

const MARKER = /[ \t]*\[cite:\s*\d+(?:\s*,\s*\d+)*\s*\]|\[cite_(?:start|end)\]/g;
// The end of a piece that may be the start of a marker the next piece finishes, with the blanks
// before it, which go with a [cite: n].
const PARTIAL = /[ \t]*(?:\[(?:c(?:i(?:t(?:e(?:_(?:s(?:t(?:a(?:r(?:t)?)?)?)?|e(?:n(?:d)?)?)?|:[\d,\s]*)?)?)?)?)?)?$/;

export function stripCites(text) {
  return typeof text === 'string' ? text.replace(MARKER, '') : text;
}

// CiteFilter strips one streamed text: push gives what can go now, holding back an end that may
// be a marker's start; flush gives what it held.
export class CiteFilter {
  held = '';

  push(piece) {
    const text = stripCites(this.held + piece);
    const tail = PARTIAL.exec(text)[0];
    this.held = tail;
    return text.slice(0, text.length - tail.length);
  }

  flush() {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}

// The streamed texts of a chat completion chunk: each choice's content and reasoning, and
// each tool call's arguments.
function* texts(chunk) {
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    const d = choice?.delta;
    if (!d || typeof d !== 'object') continue;
    const at = choice.index ?? 0;
    for (const field of ['content', 'reasoning_content', 'reasoning']) {
      if (typeof d[field] === 'string') yield { key: `${at}:${field}`, get: () => d[field], set: v => { d[field] = v; } };
    }
    for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const fn = call?.function;
      if (typeof fn?.arguments === 'string') {
        yield { key: `${at}:tool:${call.index ?? 0}`, get: () => fn.arguments, set: v => { fn.arguments = v; } };
      }
    }
  }
}

// heldChunk is a chunk carrying what the filters still hold, for the end of a stream, made
// after last, the stream's last chunk.
function heldChunk(filters, last) {
  const choices = new Map();
  for (const [key, f] of filters) {
    const rest = f.flush();
    if (!rest) continue;
    const [at, kind, call] = key.split(':');
    const index = Number(at);
    if (!choices.has(index)) choices.set(index, { index, delta: {} });
    const delta = choices.get(index).delta;
    if (kind === 'tool') (delta.tool_calls ??= []).push({ index: Number(call), function: { arguments: rest } });
    else delta[kind] = rest;
  }
  if (!choices.size) return null;
  const { id, object, created, model } = last || {};
  return { id, object, created, model, choices: [...choices.values()] };
}

// mergeHeld adds what the filters hold to chunk, in the choices it names (others get their own).
function mergeHeld(chunk, filters) {
  const held = heldChunk(filters, chunk);
  for (const h of held?.choices ?? []) {
    const c = chunk.choices.find(x => (x?.index ?? 0) === h.index);
    if (!c) {
      chunk.choices.push(h);
      continue;
    }
    const d = (c.delta ??= {});
    for (const [field, rest] of Object.entries(h.delta)) {
      if (field !== 'tool_calls') {
        d[field] = (typeof d[field] === 'string' ? d[field] : '') + rest;
        continue;
      }
      for (const call of rest) {
        const same = (d.tool_calls ??= []).find(x => (x?.index ?? 0) === call.index);
        if (same) (same.function ??= {}).arguments = (same.function.arguments ?? '') + call.function.arguments;
        else d.tool_calls.push(call);
      }
    }
  }
}

// citeStream strips the markers from an SSE stream of chat completion chunks. An event that
// isn't a chunk goes on as it came; what the filters hold goes out before the stream ends.
export function citeStream(body) {
  const filters = new Map();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let last = null;

  const event = data => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const flushAll = controller => {
    const chunk = heldChunk(filters, last);
    if (chunk) controller.enqueue(event(chunk));
  };

  const handle = (raw, controller) => {
    const data = /^data: ?(.*)$/s.exec(raw)?.[1];
    if (data === undefined) return controller.enqueue(encoder.encode(raw + '\n\n'));
    if (data.trim() === '[DONE]') {
      flushAll(controller);
      return controller.enqueue(encoder.encode(raw + '\n\n'));
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return controller.enqueue(encoder.encode(raw + '\n\n'));
    }
    last = chunk;
    for (const t of texts(chunk)) {
      if (!filters.has(t.key)) filters.set(t.key, new CiteFilter());
      t.set(filters.get(t.key).push(t.get()));
    }
    // a client may take the chunk that finishes a choice for its end: what is held goes in it
    if (Array.isArray(chunk.choices) && chunk.choices.some(c => c?.finish_reason)) mergeHeld(chunk, filters);
    controller.enqueue(event(chunk));
  };

  return body.pipeThrough(new TransformStream({
    transform(piece, controller) {
      buffer += decoder.decode(piece, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const raw of events) if (raw) handle(raw, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer.replace(/\s+$/, ''), controller);
      flushAll(controller);
    }
  }));
}

// citeJSON strips the markers from a whole chat completion.
export function citeJSON(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  for (const choice of Array.isArray(body?.choices) ? body.choices : []) {
    const m = choice?.message;
    if (!m || typeof m !== 'object') continue;
    for (const field of ['content', 'reasoning_content', 'reasoning']) m[field] = stripCites(m[field]);
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (call?.function) call.function.arguments = stripCites(call.function.arguments);
    }
  }
  return JSON.stringify(body);
}

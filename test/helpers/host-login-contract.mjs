// Replicas of the Agent2API v3.5.1 and Magpie sign-in contracts that issue #79 ran into.
// login-prompts.mjs drops a dynamic field whose key is already static, and
// add-account-plugin-prompts.ts then discards the answered value. session.rs rejects every
// login method on a provider when any static select has no options. Magpie forwards authorize
// inputs only when prompts.length > 0, and skips its own API key box once prompts and
// authorize are both declared.

export function emptyStaticSelects(methods) {
  const found = [];
  for (const method of methods) {
    for (const prompt of method.prompts ?? []) {
      if (prompt.type === 'select' && !(prompt.options ?? []).length) found.push(`${method.label}:${prompt.key}`);
    }
  }
  return found;
}

function applies(prompt, inputs) {
  const rule = prompt.when ?? (typeof prompt.condition === 'object' ? prompt.condition : null);
  if (rule) {
    if (!Object.hasOwn(inputs, rule.key)) return false;
    const equal = inputs[rule.key] === rule.value;
    if (rule.op === 'eq' ? !equal : equal) return false;
  }
  return typeof prompt.condition !== 'function' || Boolean(prompt.condition(inputs));
}

function promptView(prompt) {
  return {
    key: prompt.key,
    type: prompt.type === 'select' ? 'select' : 'text',
    label: prompt.message || prompt.label || prompt.key,
    options: (prompt.options ?? []).map(option => ({ value: option.value, label: option.label || option.value }))
  };
}

export async function resolvePrompts(method, inputs) {
  const prompts = [];
  for (const prompt of method.prompts ?? []) {
    if (!applies(prompt, inputs)) continue;
    prompts.push(promptView(prompt));
  }
  if (typeof method.ask === 'function') {
    const next = await method.ask(inputs);
    if (next && !prompts.some(prompt => prompt.key === next.key)) prompts.push(promptView(next));
  }
  return prompts;
}

export function retainAnswered(method, previous, next, inputs) {
  return [
    ...previous.filter(prompt => !(method.prompts ?? []).some(item => item.key === prompt.key)
      && Object.hasOwn(inputs, prompt.key) && !next.some(item => item.key === prompt.key)),
    ...next
  ];
}

export function magpiePassesInputs(method) {
  return Boolean(method.prompts?.length);
}

const MULTILINE_LABEL = /JSON|Cookie|PEM/i;

export function apiKeyField(method) {
  return (method.prompts ?? []).find(prompt => prompt.key === 'key');
}

export function multilineKeyLabel(method) {
  const field = apiKeyField(method);
  return Boolean(field && MULTILINE_LABEL.test(field.message || ''));
}

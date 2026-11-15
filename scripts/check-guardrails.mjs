#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NODE_BUILTINS = new Set(builtinModules.map(m => (m.startsWith('node:') ? m : `node:${m}`)));
const RUNTIME_BUILTINS = new Set([
  ...NODE_BUILTINS,
  'node:sqlite',
  'node:test',
  'node:test/reporters',
  'bun:sqlite'
]);

export const RULES = [
  'no-raw-kill-zero',
  'layer-boundary',
  'no-external-or-bare-imports',
  'closed-package-files-graph',
  'unix-shebang-lf',
  'agents-doc-links-valid'
];

const REGEX_BEFORE_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'in', 'instanceof',
  'typeof', 'void', 'delete', 'await', 'yield', 'new', 'else', 'do', 'of'
]);

const NON_REGEX_PUNCT = new Set(['++', '--', ')', ']', '}']);

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function walkFiles(dir, { exts } = {}) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (!exts || exts.has(path.extname(entry.name)))) results.push(full);
    }
  }
  return results.sort();
}

function scanJavaScript(source) {
  const len = source.length;
  const out = [];
  const tokens = [];
  const modeStack = [];
  const parenStack = [];

  let i = 0;
  let line = 1;
  let prevToken = null;

  const currentMode = () => modeStack[modeStack.length - 1];
  const pushBlank = ch => { out.push(ch === '\n' ? '\n' : ' '); };
  const allowRegex = () => {
    if (!prevToken) return true;
    if (prevToken.type === 'ident') return REGEX_BEFORE_KEYWORDS.has(prevToken.value);
    if (prevToken.type === 'punct') {
      if (prevToken.value === ')') return !!prevToken.allowsRegex;
      return !NON_REGEX_PUNCT.has(prevToken.value);
    }
    return false;
  };

  while (i < len) {
    const mode = currentMode();
    if (mode && mode.kind === 'template') {
      const ch = source[i];
      if (ch === '\\' && i + 1 < len) {
        pushBlank(ch);
        pushBlank(source[i + 1]);
        if (source[i + 1] === '\n') line++;
        else if (!mode.interpolated) mode.staticValue += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        out.push(' ', ' ');
        mode.interpolated = true;
        tokens.push({ type: 'template-expr-start', value: '${', line });
        modeStack.push({ kind: 'expr', braceDepth: 1 });
        prevToken = { type: 'punct', value: '{' };
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push(' ');
        modeStack.pop();
        const tok = mode.interpolated
          ? { type: 'template', value: '`', line: mode.startLine }
          : { type: 'template-static', value: mode.staticValue, line: mode.startLine };
        prevToken = tok;
        tokens.push(tok);
        i += 1;
        continue;
      }
      pushBlank(ch);
      if (ch === '\n') line++;
      if (!mode.interpolated) mode.staticValue += ch;
      i += 1;
      continue;
    }

    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '\n') {
      out.push('\n');
      line += 1;
      i += 1;
      continue;
    }

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      while (i < len && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        pushBlank(source[i]);
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      if (i + 1 < len) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }

    // Hashbang on first line
    if (i === 0 && ch === '#' && source[i + 1] === '!') {
      while (i < len && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    // Single or double quoted string
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      const startLine = line;
      let val = '';
      out.push(' ');
      i += 1;
      while (i < len) {
        const c = source[i];
        if (c === '\\' && i + 1 < len) {
          pushBlank(c);
          pushBlank(source[i + 1]);
          if (source[i + 1] === '\n') line += 1;
          else val += source[i + 1];
          i += 2;
          continue;
        }
        pushBlank(c);
        if (c === '\n') {
          line += 1;
          i += 1;
          break;
        }
        i += 1;
        if (c === quote) break;
        val += c;
      }
      const tok = { type: 'string', value: val, line: startLine };
      tokens.push(tok);
      prevToken = tok;
      continue;
    }

    // Template literal start
    if (ch === '`') {
      out.push(' ');
      modeStack.push({ kind: 'template', startLine: line, staticValue: '', interpolated: false });
      i += 1;
      continue;
    }

    // Regex literal vs division
    if (ch === '/' && allowRegex()) {
      const startLine = line;
      out.push(' ');
      i += 1;
      let inClass = false;
      while (i < len) {
        const c = source[i];
        if (c === '\\' && i + 1 < len && source[i + 1] !== '\n') {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (c === '\n') {
          out.push('\n');
          line += 1;
          i += 1;
          break;
        }
        out.push(' ');
        i += 1;
        if (c === '[') inClass = true;
        else if (c === ']' && inClass) inClass = false;
        else if (c === '/' && !inClass) break;
      }
      while (i < len && /[a-z]/i.test(source[i])) {
        out.push(' ');
        i += 1;
      }
      const tok = { type: 'regex', value: '/re/', line: startLine };
      tokens.push(tok);
      prevToken = tok;
      continue;
    }

    // Identifiers & keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const ident = source.slice(start, i);
      out.push(ident);
      const tok = { type: 'ident', value: ident, line };
      tokens.push(tok);
      prevToken = tok;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < len && /[0-9A-Za-z_.]/.test(source[i])) i += 1;
      const num = source.slice(start, i);
      out.push(num);
      const tok = { type: 'number', value: num, line };
      tokens.push(tok);
      prevToken = tok;
      continue;
    }

    // Multi-character operators needed for accurate regex/division disambiguation
    let punct = ch;
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (three === '>>>' || three === '===' || three === '!==' || three === '...') {
      punct = three;
    } else if (two === '++' || two === '--' || two === '=>' || two === '==' || two === '!=' ||
               two === '<=' || two === '>=' || two === '&&' || two === '||' || two === '??' ||
               two === '**' || two === '<<' || two === '>>' || two === '+=' || two === '-=' ||
               two === '*=' || two === '/=' || two === '%=') {
      punct = two;
    }

    if (punct === '{') {
      if (mode && mode.kind === 'expr') mode.braceDepth += 1;
      out.push('{');
      const tok = { type: 'punct', value: '{', line };
      tokens.push(tok);
      prevToken = tok;
      i += 1;
      continue;
    }
    if (punct === '}') {
      if (mode && mode.kind === 'expr') {
        mode.braceDepth -= 1;
        if (mode.braceDepth === 0) {
          modeStack.pop();
          out.push(' ');
          tokens.push({ type: 'template-expr-end', value: '}', line });
          i += 1;
          continue;
        }
      }
      out.push('}');
      const tok = { type: 'punct', value: '}', line };
      tokens.push(tok);
      prevToken = tok;
      i += 1;
      continue;
    }
    if (punct === '(') {
      const condHeader = prevToken?.type === 'ident' && ['if', 'while', 'for', 'with'].includes(prevToken.value);
      parenStack.push(condHeader);
    }

    out.push(punct);
    const tok = { type: 'punct', value: punct, line };
    if (punct === ')') tok.allowsRegex = parenStack.length > 0 ? parenStack.pop() : false;
    tokens.push(tok);
    prevToken = tok;
    i += punct.length;
  }

  return { stripped: out.join(''), tokens };
}

export function stripCommentsAndStrings(source) {
  return scanJavaScript(source).stripped;
}

export function extractModuleSpecifiers(source) {
  const { tokens } = scanJavaScript(source);
  const specifiers = [];
  const staticValue = t => (t && (t.type === 'string' || t.type === 'template-static') ? t.value : null);

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const afterDot = prev?.type === 'punct' && prev.value === '.';
    const afterDecl = prev?.type === 'ident' && (prev.value === 'function' || prev.value === 'class');

    if (tok.type === 'ident' && tok.value === 'import' && !afterDot && !afterDecl) {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'punct' && next.value === '(') {
        const arg = tokens[i + 2];
        const val = staticValue(arg);
        if (val !== null) {
          specifiers.push({ specifier: val, line: arg.line, kind: 'dynamic-import' });
        }
        continue;
      }
      const nextVal = staticValue(next);
      if (nextVal !== null) {
        specifiers.push({ specifier: nextVal, line: next.line, kind: 'import' });
        i += 1;
        continue;
      }
      let brace = 0;
      for (let j = i + 1; j < tokens.length; j += 1) {
        const t = tokens[j];
        if (t.type === 'punct' && t.value === '{') brace += 1;
        else if (t.type === 'punct' && t.value === '}') {
          brace -= 1;
          if (brace < 0) break;
        } else if (t.type === 'punct' && (t.value === ';' || t.value === '=' || t.value === '(')) {
          break;
        } else if (brace === 0 && t.type === 'ident' && t.value === 'from') {
          const targetVal = staticValue(tokens[j + 1]);
          if (targetVal !== null) {
            specifiers.push({ specifier: targetVal, line: tokens[j + 1].line, kind: 'import' });
            i = j + 1;
            break;
          }
        }
      }
      continue;
    }

    if (tok.type === 'ident' && tok.value === 'export' && !afterDot && !afterDecl) {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'punct' && next.value === '*') {
        let j = i + 2;
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'as' && tokens[j + 1]?.type === 'ident') j += 2;
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'from') {
          const targetVal = staticValue(tokens[j + 1]);
          if (targetVal !== null) {
            specifiers.push({ specifier: targetVal, line: tokens[j + 1].line, kind: 'export' });
            i = j + 1;
          }
        }
        continue;
      }
      if (next.type === 'punct' && next.value === '{') {
        let brace = 1;
        let j = i + 2;
        while (j < tokens.length && brace > 0) {
          if (tokens[j].type === 'punct' && tokens[j].value === '{') brace += 1;
          else if (tokens[j].type === 'punct' && tokens[j].value === '}') brace -= 1;
          j += 1;
        }
        if (brace === 0 && tokens[j]?.type === 'ident' && tokens[j].value === 'from') {
          const targetVal = staticValue(tokens[j + 1]);
          if (targetVal !== null) {
            specifiers.push({ specifier: targetVal, line: tokens[j + 1].line, kind: 'export' });
            i = j + 1;
          }
        }
        continue;
      }
    }

    if (tok.type === 'ident' && tok.value === 'require' && !afterDot && !afterDecl) {
      const arg = tokens[i + 2];
      const argVal = staticValue(arg);
      if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(' &&
          argVal !== null &&
          tokens[i + 3]?.type === 'punct' && tokens[i + 3].value === ')') {
        specifiers.push({ specifier: argVal, line: arg.line, kind: 'require' });
        i += 3;
      }
    }
  }

  return specifiers;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function resolveRelativeTarget(rootDir, importerRel, specifier) {
  const importerAbs = path.join(rootDir, importerRel);
  const resolvedAbs = path.resolve(path.dirname(importerAbs), specifier);
  const rel = path.relative(rootDir, resolvedAbs);
  return { abs: resolvedAbs, rel: toPosix(rel) };
}

function isProcessRef(tokens, idx) {
  if (idx < 0 || tokens[idx]?.type !== 'ident' || tokens[idx].value !== 'process') return false;
  if (idx === 0) return true;
  if (tokens[idx - 1]?.type !== 'punct' || tokens[idx - 1].value !== '.') return true;
  return idx >= 2 && tokens[idx - 2]?.type === 'ident' && tokens[idx - 2].value === 'globalThis' &&
    (idx === 2 || tokens[idx - 3]?.type !== 'punct' || tokens[idx - 3].value !== '.');
}

function collectKillAliases(tokens) {
  const aliases = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    // Direct alias: foo = process.kill (or globalThis.process.kill)
    if (tokens[i]?.type === 'punct' && tokens[i].value === '=' &&
        isProcessRef(tokens, i + 1) &&
        tokens[i + 2]?.type === 'punct' && tokens[i + 2].value === '.' &&
        tokens[i + 3]?.type === 'ident' && tokens[i + 3].value === 'kill') {
      if (tokens[i - 1]?.type === 'ident') aliases.add(tokens[i - 1].value);
    }

    // Object destructuring: { kill } = process OR { kill: alias } = process
    if (tokens[i]?.type === 'punct' && tokens[i].value === '}' &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '=' &&
        isProcessRef(tokens, i + 2)) {
      let open = -1;
      let depth = 0;
      for (let j = i; j >= 0; j -= 1) {
        if (tokens[j].type === 'punct' && tokens[j].value === '}') depth += 1;
        else if (tokens[j].type === 'punct' && tokens[j].value === '{') {
          depth -= 1;
          if (depth === 0) {
            open = j;
            break;
          }
        }
      }
      if (open >= 0) {
        for (let k = open + 1; k < i; k += 1) {
          if (tokens[k]?.type === 'ident' && tokens[k].value === 'kill') {
            const before = tokens[k - 1];
            if (before?.type === 'punct' && (before.value === '{' || before.value === ',')) {
              if (tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === ':' && tokens[k + 2]?.type === 'ident') {
                aliases.add(tokens[k + 2].value);
              } else {
                aliases.add('kill');
              }
            }
          }
        }
      }
    }
  }
  return aliases;
}

function isZeroSignalExpr(exprTokens) {
  let toks = exprTokens;
  while (toks.length >= 2 && toks[0].type === 'punct' && toks[0].value === '(' &&
         toks[toks.length - 1].type === 'punct' && toks[toks.length - 1].value === ')') {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < toks.length - 1; i += 1) {
      if (toks[i].type === 'punct' && toks[i].value === '(') depth += 1;
      else if (toks[i].type === 'punct' && toks[i].value === ')') depth -= 1;
      if (depth === 0) {
        wrapsWhole = false;
        break;
      }
    }
    if (!wrapsWhole) break;
    toks = toks.slice(1, -1);
  }
  if (toks.length === 1 && toks[0].type === 'number') {
    return Number(toks[0].value) === 0;
  }
  if (toks.length === 2 && toks[0].type === 'punct' && (toks[0].value === '+' || toks[0].value === '-') && toks[1].type === 'number') {
    return Number(toks[1].value) === 0;
  }
  return false;
}

function findRawKillZeroLines(tokens) {
  const aliases = collectKillAliases(tokens);
  const lines = [];

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== 'punct' || tokens[i].value !== '(') continue;

    let callLine = null;
    if (tokens[i - 1]?.type === 'ident' && tokens[i - 1].value === 'kill' &&
        tokens[i - 2]?.type === 'punct' && tokens[i - 2].value === '.' &&
        isProcessRef(tokens, i - 3)) {
      callLine = tokens[i - 1].line;
    } else if (tokens[i - 1]?.type === 'ident' && aliases.has(tokens[i - 1].value) &&
        !(tokens[i - 2]?.type === 'punct' && tokens[i - 2].value === '.')) {
      callLine = tokens[i - 1].line;
    }
    if (!callLine) continue;

    const args = [[]];
    let depth = 1;
    for (let j = i + 1; j < tokens.length && depth > 0; j += 1) {
      const t = tokens[j];
      if (t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
        depth += 1;
      } else if (t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) {
        depth -= 1;
        if (depth === 0) break;
      } else if (depth === 1 && t.type === 'punct' && t.value === ',') {
        args.push([]);
        continue;
      }
      args[args.length - 1].push(t);
    }

    if (args.length >= 2 && isZeroSignalExpr(args[1])) {
      lines.push(callLine);
    }
  }
  return lines;
}

function extractNodeScriptTargets(cmd) {
  const targets = [];
  const words = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
      } else if (c === quote) {
        quote = '';
      } else {
        cur += c;
      }
    } else if (c === '\'' || c === '"') {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { words.push(cur); cur = ''; }
    } else if (cmd.slice(i, i + 2) === '&&' || cmd.slice(i, i + 2) === '||') {
      if (cur) { words.push(cur); cur = ''; }
      words.push(';');
      i += 1;
    } else if (c === ';' || c === '|') {
      if (cur) { words.push(cur); cur = ''; }
      words.push(';');
    } else {
      cur += c;
    }
  }
  if (cur) words.push(cur);

  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 'node') continue;
    let testMode = false;
    for (let j = i + 1; j < words.length && words[j] !== ';'; j += 1) {
      const arg = words[j];
      if (arg === '--test') { testMode = true; continue; }
      if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print' ||
          arg === '-c' || arg === '--check' || arg === '-v' || arg === '--version' || arg === '-h' || arg === '--help') {
        break;
      }
      if (arg === '-r' || arg === '--require' || arg === '--import') {
        const next = words[++j];
        if (next && next !== ';' && !next.includes('*') &&
            (next.startsWith('.') || /^(?:index\.mjs|(?:lib|scripts|test)\/)/.test(next))) {
          targets.push(next);
        }
        continue;
      }
      if (arg.startsWith('-')) continue;
      if (!arg.includes('*')) targets.push(arg);
      if (!testMode) break;
    }
  }
  return targets;
}

export function checkGuardrails({ rootDir = REPO_ROOT } = {}) {
  const root = path.resolve(rootDir);
  const violations = [];
  const jsExts = new Set(['.mjs', '.cjs']);

  const collectGroup = dirName => {
    const absDir = path.join(root, dirName);
    return walkFiles(absDir, { exts: jsExts }).map(abs => toPosix(path.relative(root, abs)));
  };

  const entryFiles = fs.existsSync(path.join(root, 'index.mjs')) ? ['index.mjs'] : [];
  const libFiles = collectGroup('lib');
  const scriptFiles = collectGroup('scripts');
  const testFiles = collectGroup('test');
  const runtimeFiles = [...entryFiles, ...libFiles];
  const allCodeFiles = [...runtimeFiles, ...scriptFiles, ...testFiles];
  const workflowFiles = walkFiles(path.join(root, '.github', 'workflows'), { exts: new Set(['.yml', '.yaml']) })
    .map(abs => toPosix(path.relative(root, abs)));

  const sourceCache = new Map();
  const parsedCache = new Map();
  const readCached = rel => {
    if (!sourceCache.has(rel)) sourceCache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    return sourceCache.get(rel);
  };
  const parseCached = rel => {
    if (!parsedCache.has(rel)) parsedCache.set(rel, scanJavaScript(readCached(rel)));
    return parsedCache.get(rel);
  };

  // Rule 1: no-raw-kill-zero
  for (const rel of [...runtimeFiles, ...scriptFiles]) {
    if (rel === 'lib/proc.mjs') continue;
    for (const line of findRawKillZeroLines(parseCached(rel).tokens)) {
      violations.push({
        rule: 'no-raw-kill-zero',
        file: rel,
        line,
        message: 'Raw process.kill(pid, 0) misses Linux container zombie processes (state Z/X).',
        fix: 'Use processAlive(pid) or processExists(pid) from ./proc.mjs (or ../lib/proc.mjs) so Linux container zombie processes (state Z/X) are handled.'
      });
    }
  }

  // Rule 2 & 3: layer-boundary & no-external-or-bare-imports
  for (const rel of allCodeFiles) {
    const specs = extractModuleSpecifiers(readCached(rel));
    const isRuntime = rel === 'index.mjs' || rel.startsWith('lib/');
    const isScript = rel.startsWith('scripts/');

    for (const { specifier, line } of specs) {
      if (specifier.startsWith('.')) {
        const target = resolveRelativeTarget(root, rel, specifier);
        const escapesRoot = target.rel.startsWith('..') || path.isAbsolute(target.rel);
        if (escapesRoot || (isRuntime && !target.rel.startsWith('lib/')) || (isScript && target.rel.startsWith('test/'))) {
          violations.push({
            rule: 'layer-boundary',
            file: rel,
            line,
            message: `Disallowed cross-layer import "${specifier}" -> "${target.rel}".`,
            fix: 'Keep runtime logic in lib/ and never import scripts/ or test/ from runtime modules (or test/ from scripts/).'
          });
        }
        continue;
      }

      if (!RUNTIME_BUILTINS.has(specifier)) {
        violations.push({
          rule: 'no-external-or-bare-imports',
          file: rel,
          line,
          message: `Disallowed external or bare specifier "${specifier}".`,
          fix: "Use explicit 'node:<builtin>' specifiers for Node built-ins and keep magpie-gemini-web zero-dependency."
        });
      }
    }
  }

  // Rule 4: closed-package-files-graph
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      violations.push({
        rule: 'closed-package-files-graph',
        file: 'package.json',
        line: 1,
        message: `package.json declares forbidden runtime dependencies: ${Object.keys(pkg.dependencies).join(', ')}.`,
        fix: 'Keep package.json dependencies empty so tests and installed plugins require zero external packages.'
      });
    }

    const shippedSet = new Set();
    const forbiddenEntry = /(?:^|\/)(?:\.env|.*secret.*|.*\.db|backend-build|studio-build)(?:$|\/)/i;
    for (const entry of pkg.files || []) {
      const normalized = toPosix(entry).replace(/^\.\//, '');
      const abs = path.join(root, normalized);
      if (!fs.existsSync(abs)) {
        violations.push({
          rule: 'closed-package-files-graph',
          file: 'package.json',
          line: 1,
          message: `package.json "files" entry does not exist: "${entry}".`,
          fix: 'Remove missing paths from package.json "files" or restore the missing file.'
        });
        continue;
      }
      if (forbiddenEntry.test(normalized.replace(/\/$/, ''))) {
        violations.push({
          rule: 'closed-package-files-graph',
          file: 'package.json',
          line: 1,
          message: `package.json "files" entry matches sensitive/build pattern: "${entry}".`,
          fix: 'Never ship credentials, .env files, databases, or local build directories in the npm tarball.'
        });
      }
      if (fs.statSync(abs).isDirectory()) {
        for (const f of walkFiles(abs)) {
          const rel = toPosix(path.relative(root, f));
          if (forbiddenEntry.test(rel)) {
            violations.push({
              rule: 'closed-package-files-graph',
              file: 'package.json',
              line: 1,
              message: `Shipped directory "${entry}" contains forbidden file "${rel}".`,
              fix: 'Remove secrets, databases, or build artifacts from shipped directories before packing.'
            });
          } else {
            shippedSet.add(rel);
          }
        }
      } else {
        shippedSet.add(normalized);
      }
    }

    for (const rel of shippedSet) {
      if (!rel.endsWith('.mjs') && !rel.endsWith('.cjs')) continue;
      for (const { specifier, line } of extractModuleSpecifiers(readCached(rel))) {
        if (!specifier.startsWith('.')) continue;
        const target = resolveRelativeTarget(root, rel, specifier);
        if (!fs.existsSync(target.abs) || !fs.statSync(target.abs).isFile() || !shippedSet.has(target.rel)) {
          violations.push({
            rule: 'closed-package-files-graph',
            file: rel,
            line,
            message: `Shipped file "${rel}" imports "${specifier}" ("${target.rel}"), which is missing or omitted from package.json "files".`,
            fix: 'Add the imported file to package.json "files" or move dev-only imports out of shipped files.'
          });
        }
      }
    }

    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      if (typeof cmd !== 'string') continue;
      for (const target of extractNodeScriptTargets(cmd)) {
        if (!fs.existsSync(path.join(root, target))) {
          violations.push({
            rule: 'closed-package-files-graph',
            file: 'package.json',
            line: 1,
            message: `npm script "${name}" points to missing file "${target}".`,
            fix: `Update package.json scripts.${name} or restore "${target}".`
          });
        }
      }
    }
  }

  // Rule 5: unix-shebang-lf
  for (const rel of [...runtimeFiles, ...scriptFiles, ...workflowFiles]) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    const crlf = content.indexOf('\r\n');
    if (crlf !== -1) {
      violations.push({
        rule: 'unix-shebang-lf',
        file: rel,
        line: lineNumberAt(content, crlf),
        message: 'File uses CRLF (\\r\\n) line endings instead of LF (\\n).',
        fix: 'Convert CRLF (\\r\\n) to LF (\\n) so Unix/container shebangs and patch tooling work reliably.'
      });
    }
  }

  // Rule 6: agents-doc-links-valid
  const agentsPath = path.join(root, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const agents = fs.readFileSync(agentsPath, 'utf8');
    const pathPattern = /(?<![A-Za-z0-9_./-])((?:index\.mjs|package\.json|jsconfig\.json|(?:lib|scripts|test|docs|\.github|patches)\/[A-Za-z0-9._/*<>-]+))/g;
    for (const match of agents.matchAll(pathPattern)) {
      const candidate = match[1].replace(/\.+$/, '');
      if (!candidate || candidate.includes('*') || candidate.includes('<') || candidate.includes('>')) continue;
      if (!fs.existsSync(path.join(root, candidate))) {
        violations.push({
          rule: 'agents-doc-links-valid',
          file: 'AGENTS.md',
          line: lineNumberAt(agents, match.index),
          message: `AGENTS.md references non-existent path "${candidate}".`,
          fix: 'Update AGENTS.md so every referenced file or directory matches the current repository layout.'
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    checkedFiles: allCodeFiles.length + workflowFiles.length + (fs.existsSync(pkgPath) ? 1 : 0) + (fs.existsSync(agentsPath) ? 1 : 0),
    rules: RULES,
    violations
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/check-guardrails.mjs [--json]');
    return;
  }
  const asJson = args.includes('--json');
  const unknown = args.filter(a => a !== '--json');
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}`);
    process.exitCode = 2;
    return;
  }

  const report = checkGuardrails();
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`PASS guardrails (${report.checkedFiles} files, ${report.rules.length} rules)`);
  } else {
    for (const v of report.violations) {
      console.error(`[${v.rule}] ${v.file}:${v.line} — ${v.message}`);
      console.error(`  Fix: ${v.fix}`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

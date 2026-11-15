import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RULES,
  stripCommentsAndStrings,
  extractModuleSpecifiers,
  checkGuardrails
} from '../scripts/check-guardrails.mjs';

function makeTempRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-guardrails-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });

  fs.writeFileSync(path.join(root, 'index.mjs'), "import { processAlive } from './lib/proc.mjs';\nexport { processAlive };\n");
  fs.writeFileSync(path.join(root, 'lib', 'proc.mjs'), "export function processAlive(pid) {\n  try { process.kill(pid, 0); return true; } catch { return false; }\n}\n");
  fs.writeFileSync(path.join(root, 'scripts', 'helper.mjs'), "import { processAlive } from '../lib/proc.mjs';\nconsole.log(processAlive(1));\n");
  fs.writeFileSync(path.join(root, 'test', 'sample.test.mjs'), "import { it } from 'node:test';\nit('ok', () => {});\n");
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), "name: test\non: push\njobs: {}\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '0.0.1',
    type: 'module',
    main: './index.mjs',
    files: ['index.mjs', 'lib/'],
    scripts: {
      test: 'node --test test/*.test.mjs',
      helper: 'node scripts/helper.mjs'
    }
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'See `index.mjs`, `lib/proc.mjs`, and `scripts/helper.mjs`.\n');
  return root;
}

describe('Static guardrails', () => {
  it('passes cleanly on the current repository', () => {
    const result = checkGuardrails();
    assert.deepEqual(result.rules, RULES);
    assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
    assert.deepEqual(result.violations, []);
  });

  it('strips comments, strings, and regexes while preserving division, template expressions, and line numbers', () => {
    const sample = [
      'const a = 10;',
      '// process.kill(pid, 0) in line comment',
      'const x = a / 2;',
      'const re = /process\\.kill\\(pid, 0\\)/g;',
      'const msg = `skip ${process.kill(pid, 0)} done`;',
      'const real = process.kill(pid, 0);'
    ].join('\n');

    const stripped = stripCommentsAndStrings(sample);
    const lines = stripped.split('\n');
    assert.equal(lines.length, 6);
    assert.equal(lines[1].includes('process.kill'), false);
    assert.equal(lines[3].includes('process.kill'), false);
    assert.match(lines[2], /^const x = a \/ 2;$/);
    assert.match(lines[4], /process\.kill\(pid, 0\)/, 'executable ${...} code must remain visible');
    assert.match(lines[5], /process\.kill\(pid, 0\)/);
  });

  it('extracts static, dynamic, export, and require specifiers while ignoring strings and comments', () => {
    const longSpecifiers = Array.from({ length: 71 }, (_, idx) => `a${idx}`).join(', ');
    const sample = [
      "// import fake from 'not-a-dep';",
      "import fs from 'node:fs';",
      "import {\n  helper\n} from './lib/helper.mjs';",
      "const msg = \"import foo from 'bad-pkg'\";",
      "export * from './reexport.mjs';",
      "const db = await import('bun:sqlite');",
      "const path = require('node:path');",
      "const dyn = await import(`lodash`);",
      `import { ${longSpecifiers} } from 'many-names';`
    ].join('\n');

    assert.deepEqual(extractModuleSpecifiers(sample), [
      { specifier: 'node:fs', line: 2, kind: 'import' },
      { specifier: './lib/helper.mjs', line: 5, kind: 'import' },
      { specifier: './reexport.mjs', line: 7, kind: 'export' },
      { specifier: 'bun:sqlite', line: 8, kind: 'dynamic-import' },
      { specifier: 'node:path', line: 9, kind: 'require' },
      { specifier: 'lodash', line: 10, kind: 'dynamic-import' },
      { specifier: 'many-names', line: 11, kind: 'import' }
    ]);
  });

  it('fails no-raw-kill-zero outside lib/proc.mjs across nested calls, +0, and destructured aliases', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'lib', 'bad.mjs'), [
      'export function check(pid, raw) {',
      '  process.kill(Number(pid), 0);',
      '  process.kill(parseInt(raw, 10), +0);',
      '  const { kill } = process;',
      '  kill(pid, (0));',
      "  process.kill(pid, 'SIGTERM');",
      '}'
    ].join('\n') + '\n');
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const v = result.violations.filter(x => x.rule === 'no-raw-kill-zero');
    assert.deepEqual(v.map(x => x.line), [2, 3, 5]);
    assert.match(v[0].fix, /processAlive.*processExists/);
  });

  it('fails layer-boundary when lib/ imports scripts/ or scripts/ imports test/', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'lib', 'cross.mjs'), "import '../scripts/helper.mjs';\n");
    fs.writeFileSync(path.join(root, 'scripts', 'bad-script.mjs'), "import '../test/sample.test.mjs';\n");
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const boundary = result.violations.filter(x => x.rule === 'layer-boundary');
    assert.equal(boundary.length, 2);
    assert.equal(boundary[0].file, 'lib/cross.mjs');
    assert.equal(boundary[1].file, 'scripts/bad-script.mjs');
  });

  it('fails no-external-or-bare-imports on bare node builtins and external packages', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'lib', 'bare.mjs'), "import fs from 'fs';\nimport _ from 'lodash';\n");
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const bare = result.violations.filter(x => x.rule === 'no-external-or-bare-imports');
    assert.equal(bare.length, 2);
    assert.equal(bare[0].line, 1);
    assert.equal(bare[1].line, 2);
  });

  it('fails closed-package-files-graph when a shipped module imports an unshipped file, while allowing node -e scripts', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '0.0.1',
      type: 'module',
      main: './index.mjs',
      files: ['index.mjs', 'lib/'],
      scripts: {
        evalCheck: 'node -e "console.log(1)"',
        printCheck: 'node -p "process.version"'
      }
    }, null, 2) + '\n');
    assert.equal(checkGuardrails({ rootDir: root }).ok, true);

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '0.0.1',
      type: 'module',
      main: './index.mjs',
      files: ['index.mjs']
    }, null, 2) + '\n');
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const v = result.violations.find(x => x.rule === 'closed-package-files-graph');
    assert.ok(v);
    assert.match(v.message, /lib\/proc\.mjs/);
  });

  it('fails unix-shebang-lf on CRLF line endings', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'scripts', 'crlf.mjs'), '#!/usr/bin/env node\r\nconsole.log(1);\r\n');
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const v = result.violations.find(x => x.rule === 'unix-shebang-lf');
    assert.ok(v);
    assert.equal(v.file, 'scripts/crlf.mjs');
    assert.equal(v.line, 1);
  });

  it('fails agents-doc-links-valid when AGENTS.md references a deleted path', t => {
    const root = makeTempRepo(t);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Run `scripts/does-not-exist.mjs` and check `lib/*.mjs` and `docs/<generated>`.\n');
    const result = checkGuardrails({ rootDir: root });
    assert.equal(result.ok, false);
    const docViolations = result.violations.filter(x => x.rule === 'agents-doc-links-valid');
    assert.equal(docViolations.length, 1);
    assert.match(docViolations[0].message, /scripts\/does-not-exist\.mjs/);
  });
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HAZARD_RULES = [
  {
    category: 'child-process',
    pattern: /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
    question: 'Does every child invocation avoid shell interpolation, set `windowsHide: true`, bound buffers/timeouts, and pass credentials over stdin/env rather than argv?'
  },
  {
    category: 'process-liveness',
    pattern: /\b(?:process\.kill|processAlive|processExists|zombie|setProcRoot|studioProcessStarted)\b/,
    question: 'Are Linux Z/X zombies and OS PID reuse handled without raw kill-zero probes (`lib/proc.mjs`), and are permissions errors (`EPERM`) distinguished from `ESRCH`?'
  },
  {
    category: 'filesystem-lock-or-state',
    pattern: /\b(?:writeFileSync|rmSync|unlinkSync|renameSync)\b|\.lock\b|\.studio-use\./,
    question: 'Do lock/state writes use atomic/exclusive staging or unique per-owner claims with write-then-recheck fencing and content-checked stale cleanup?'
  },
  {
    category: 'network-auth-proxy',
    pattern: /\b(?:fetch|curl|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|127\.0\.0\.1|localhost|Authorization)\b/,
    question: 'Do network calls enforce timeouts, digest/origin validation, safe proxy/container warnings, and zero secret leaks in errors/logs?'
  }
];

function toPosix(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function splitNonEmptyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(toPosix)
    .filter(Boolean);
}

function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort();
}

function runGit(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function hasHeadCommit(cwd) {
  try {
    runGit(['rev-parse', '--verify', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

function syntheticAddedDiff(relPath, cwd) {
  const full = path.join(cwd, relPath);
  if (!fs.existsSync(full)) return '';
  let stat;
  try { stat = fs.statSync(full); } catch { return ''; }
  if (!stat.isFile()) return '';
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) return '';
  const text = buf.toString('utf8');
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const plusLines = rawLines.map(line => `+${line}`).join('\n');
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${rawLines.length} @@`,
    plusLines
  ].join('\n') + '\n';
}

export function parseInterrogateArgs(argv = process.argv.slice(2)) {
  const options = {
    base: '',
    staged: false,
    files: null,
    brief: false,
    json: false,
    run: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--staged') options.staged = true;
    else if (arg === '--brief') options.brief = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--run') options.run = true;
    else if (arg === '--base') {
      const next = argv[++i];
      if (!next) throw new Error('--base requires a git ref');
      options.base = next;
    } else if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length);
      if (!options.base) throw new Error('--base requires a git ref');
    } else if (arg === '--files') {
      const next = argv[++i];
      if (!next) throw new Error('--files requires a comma-separated list');
      options.files = next.split(',').map(toPosix).filter(Boolean);
    } else if (arg.startsWith('--files=')) {
      options.files = arg.slice('--files='.length).split(',').map(toPosix).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function resolveDiff(options = {}) {
  const cwd = options.cwd || process.cwd();
  const { base, staged, files } = options;

  if (Array.isArray(files) && files.length > 0) {
    const normalized = uniqueSorted(files.map(toPosix));
    const patches = [];
    for (const rel of normalized) {
      let tracked = true;
      try {
        runGit(['ls-files', '--error-unmatch', '--', rel], cwd);
      } catch {
        tracked = false;
      }
      if (tracked) {
        const diff = hasHeadCommit(cwd)
          ? runGit(['diff', 'HEAD', '-U0', '--', rel], cwd)
          : runGit(['diff', '-U0', '--', rel], cwd);
        if (diff.trim()) {
          patches.push(diff);
          continue;
        }
      }
      const synth = syntheticAddedDiff(rel, cwd);
      if (synth) patches.push(synth);
    }
    return { mode: 'files', files: normalized, patch: patches.join('\n') };
  }

  if (staged) {
    const changed = uniqueSorted(splitNonEmptyLines(runGit(['diff', '--cached', '--name-only'], cwd)));
    const patch = runGit(['diff', '--cached', '-U0'], cwd);
    return { mode: 'staged', files: changed, patch };
  }

  if (base) {
    const changed = uniqueSorted(splitNonEmptyLines(runGit(['diff', base, '--name-only'], cwd)));
    const patch = runGit(['diff', base, '-U0'], cwd);
    return { mode: 'base', base, files: changed, patch };
  }

  const headExists = hasHeadCommit(cwd);
  const trackedChanged = headExists
    ? splitNonEmptyLines(runGit(['diff', 'HEAD', '--name-only'], cwd))
    : [
        ...splitNonEmptyLines(runGit(['diff', '--name-only'], cwd)),
        ...splitNonEmptyLines(runGit(['diff', '--cached', '--name-only'], cwd))
      ];
  const untracked = splitNonEmptyLines(runGit(['ls-files', '--others', '--exclude-standard'], cwd));
  const allFiles = uniqueSorted([...trackedChanged, ...untracked]);

  const patches = [];
  const trackedPatch = headExists
    ? runGit(['diff', 'HEAD', '-U0'], cwd)
    : [runGit(['diff', '--cached', '-U0'], cwd), runGit(['diff', '-U0'], cwd)].filter(Boolean).join('\n');
  if (trackedPatch.trim()) patches.push(trackedPatch);
  for (const rel of untracked) {
    const synth = syntheticAddedDiff(rel, cwd);
    if (synth) patches.push(synth);
  }

  return { mode: 'working-tree', files: allFiles, patch: patches.join('\n') };
}

function mapFileToSubsystemsAndTests(file, state) {
  if (file === 'lib/proc.mjs') {
    state.subsystems.add('proc-liveness');
    state.tests.add('test/zombie.test.mjs');
    state.tests.add('test/backend.test.mjs');
    state.tests.add('test/studio-lock-model.test.mjs');
    state.tests.add('test/studio-docker.test.mjs');
  }
  if (file === 'lib/studio-updates.mjs' || file.startsWith('docs/models/')) {
    state.subsystems.add('studio-updates-lock');
    state.tests.add('test/studio-updates.test.mjs');
    state.tests.add('test/studio-update-outcomes.test.mjs');
    state.tests.add('test/studio-lock-model.test.mjs');
  }
  if (file === 'lib/studio-upstream.mjs') {
    state.subsystems.add('studio-upstream');
    state.tests.add('test/studio-official.test.mjs');
    state.tests.add('test/studio-pins.test.mjs');
    state.tests.add('test/studio-updates.test.mjs');
  }
  if (file === 'lib/studio-native.mjs' || file === 'index.mjs' || /^scripts\/studio.*\.mjs$/.test(file)) {
    state.subsystems.add('studio-runtime');
    state.tests.add('test/studio-native.test.mjs');
    state.tests.add('test/studio-official.test.mjs');
    state.tests.add('test/studio-connect.test.mjs');
    state.tests.add('test/studio-connect-legacy.test.mjs');
    state.tests.add('test/studio-updates.test.mjs');
    state.tests.add('test/studio-lock-model.test.mjs');
    state.tests.add('test/studio-docker.test.mjs');
    state.tests.add('test/studio.test.mjs');
    state.tests.add('test/studio-page.test.mjs');
  }
  if (file === 'lib/studio.mjs') {
    state.subsystems.add('studio-web');
    state.tests.add('test/studio.test.mjs');
    state.tests.add('test/studio-migration.test.mjs');
    state.tests.add('test/studio-user-backend.test.mjs');
  }
  if (file === 'lib/studio-page.mjs') {
    state.subsystems.add('studio-ui');
    state.tests.add('test/studio-page.test.mjs');
    state.tests.add('test/studio.test.mjs');
  }
  if (file === 'lib/studio-connect.mjs' || file === 'lib/studio-connect-legacy.mjs') {
    state.subsystems.add('studio-connect');
    state.tests.add('test/studio-connect.test.mjs');
    state.tests.add('test/studio-connect-legacy.test.mjs');
  }
  if (file === 'lib/native.mjs') {
    state.subsystems.add('native-plugin');
    state.tests.add('test/native.test.mjs');
  }
  if (file === 'lib/setup.mjs') {
    state.subsystems.add('setup');
    state.tests.add('test/setup.test.mjs');
  }
  if (file === 'lib/cite.mjs') {
    state.subsystems.add('cite');
    state.tests.add('test/cite.test.mjs');
  }
  if (file === 'index.mjs' || file === 'lib/studio-native.mjs' || file.startsWith('lib/studio-connect') || /^scripts\/studio.*\.mjs$/.test(file) || /^test\/studio-connect.*\.test\.mjs$/.test(file)) {
    state.needsBunStudioConnect = true;
  }
  if (/^lib\/backend.*\.mjs$/.test(file) || /^scripts\/backend.*\.mjs$/.test(file)) {
    state.subsystems.add('backend');
    state.tests.add('test/backend.test.mjs');
    state.tests.add('test/backend-release.test.mjs');
    state.tests.add('test/zombie.test.mjs');
  }
  if (file === 'lib/usage.mjs' || file.startsWith('lib/cleanup')) {
    state.subsystems.add('usage-cleanup');
    state.tests.add('test/usage.test.mjs');
    state.tests.add('test/cleanup.test.mjs');
    state.tests.add('test/backend.test.mjs');
  }
  if (file === 'scripts/check-guardrails.mjs' || file === 'AGENTS.md' || file === 'jsconfig.json' || file.startsWith('docs/')) {
    state.subsystems.add('guardrails-docs');
    state.tests.add('test/guardrails.test.mjs');
  }
  if (file === 'scripts/verify-published-package.mjs' || file === 'scripts/release-plugin.mjs' || file === '.github/workflows/verify-package.yml' || /^\.github\/workflows\/publish-.*\.yml$/.test(file)) {
    state.subsystems.add('release-verify');
    state.tests.add('test/release-plugin.test.mjs');
  }
  if (file === 'scripts/interrogate-diff.mjs') {
    state.subsystems.add('interrogate');
    state.tests.add('test/interrogate-diff.test.mjs');
  }
  if (file.startsWith('.github/workflows/') || file === 'package.json') {
    state.subsystems.add('ci-workflows-package');
    state.tests.add('test/guardrails.test.mjs');
    state.tests.add('test/release-plugin.test.mjs');
    state.tests.add('test/interrogate-diff.test.mjs');
  }
  if (/^test\/[^/]+\.test\.mjs$/.test(file)) {
    state.subsystems.add('tests');
    state.tests.add(file);
  }
}

function scanPatchHazards(patch) {
  const findings = [];
  const counts = {};
  for (const rule of HAZARD_RULES) counts[rule.category] = 0;

  let currentFile = '';
  let addedLineNum = 0;
  let hunkAddedRemaining = 0;

  for (const rawLine of String(patch || '').split(/\r?\n/)) {
    if (hunkAddedRemaining === 0 && rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      currentFile = target === '/dev/null' ? '' : toPosix(target.replace(/^b\//, ''));
      addedLineNum = 0;
      continue;
    }
    if (hunkAddedRemaining === 0 && (rawLine.startsWith('diff --git ') || rawLine.startsWith('--- '))) {
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (hunk) {
      addedLineNum = Number(hunk[1]) - 1;
      hunkAddedRemaining = hunk[2] !== undefined ? Number(hunk[2]) : 1;
      continue;
    }
    if (hunkAddedRemaining > 0 && rawLine.startsWith(' ')) {
      addedLineNum += 1;
      hunkAddedRemaining = Math.max(0, hunkAddedRemaining - 1);
      continue;
    }
    if (!rawLine.startsWith('+') || (hunkAddedRemaining === 0 && rawLine.startsWith('+++'))) continue;
    if (hunkAddedRemaining > 0) hunkAddedRemaining -= 1;
    addedLineNum += 1;

    if (!currentFile || currentFile.startsWith('test/') || currentFile.startsWith('docs/') || currentFile === 'AGENTS.md') {
      continue;
    }
    const content = rawLine.slice(1);
    for (const rule of HAZARD_RULES) {
      if (rule.category === 'child-process' && /\/[gimsuyd]*\.exec\s*\(/.test(content)) continue;
      if (rule.pattern.test(content)) {
        counts[rule.category] += 1;
        findings.push({
          category: rule.category,
          file: currentFile,
          line: addedLineNum,
          snippet: content.trim().slice(0, 140)
        });
      }
    }
  }

  return { findings, counts };
}

export function analyzeDiff({ files = [], patch = '', cwd = process.cwd(), filterExisting = true } = {}) {
  const normalizedFiles = uniqueSorted(files.map(toPosix));
  const state = {
    subsystems: new Set(),
    tests: new Set(),
    needsBunStudioConnect: false
  };

  for (const file of normalizedFiles) {
    mapFileToSubsystemsAndTests(file, state);
  }

  let testFiles = uniqueSorted([...state.tests]);
  if (filterExisting) {
    testFiles = testFiles.filter(rel => fs.existsSync(path.join(cwd, rel)));
  }

  const { findings, counts } = scanPatchHazards(patch);

  const commands = [
    {
      label: 'node scripts/check-guardrails.mjs',
      command: process.execPath,
      args: ['scripts/check-guardrails.mjs']
    }
  ];

  if (testFiles.length > 0) {
    commands.push({
      label: `node --test ${testFiles.join(' ')}`,
      command: process.execPath,
      args: ['--test', ...testFiles]
    });
  }

  if (state.needsBunStudioConnect) {
    let bunTests = ['test/studio-connect.test.mjs', 'test/studio-connect-legacy.test.mjs'];
    if (filterExisting) {
      const existingBunTests = bunTests.filter(rel => fs.existsSync(path.join(cwd, rel)));
      if (existingBunTests.length > 0) bunTests = existingBunTests;
    }
    commands.push({
      label: `bun test ${bunTests.join(' ')} --timeout 15000`,
      command: 'bun',
      args: ['test', ...bunTests, '--timeout', '15000'],
      optionalRuntime: 'bun'
    });
  }

  commands.push(
    process.platform === 'win32'
      ? {
          label: 'npm pack --dry-run',
          command: process.env.ComSpec || 'cmd.exe',
          args: ['/d', '/s', '/c', 'npm pack --dry-run']
        }
      : {
          label: 'npm pack --dry-run',
          command: 'npm',
          args: ['pack', '--dry-run']
        }
  );

  return {
    files: normalizedFiles,
    subsystems: uniqueSorted([...state.subsystems]),
    testFiles,
    hazards: counts,
    hazardFindings: findings,
    commands
  };
}

export function buildInterrogateBrief(analysis) {
  const lines = [
    '# Independent Diff Interrogation Brief (Author != Verifier)',
    '',
    '## Changed Files',
    ...(analysis.files.length > 0 ? analysis.files.map(f => `- \`${f}\``) : ['- (none)']),
    '',
    '## Touched Subsystems',
    ...(analysis.subsystems.length > 0 ? analysis.subsystems.map(s => `- \`${s}\``) : ['- (none)']),
    '',
    '## Adversarial Hazard Checklist'
  ];

  const triggeredRules = HAZARD_RULES.filter(r => (analysis.hazards?.[r.category] || 0) > 0);
  if (triggeredRules.length === 0) {
    lines.push('- No high-risk hazard signatures detected on added non-test lines; verify error paths, tarball exclusions, and doc accuracy.');
  } else {
    for (const rule of triggeredRules) {
      const sample = analysis.hazardFindings
        .filter(f => f.category === rule.category)
        .slice(0, 5);
      lines.push(`- **${rule.category}** (${analysis.hazards[rule.category]} added line matches): ${rule.question}`);
      for (const hit of sample) {
        lines.push(`  - \`${hit.file}:${hit.line}\` — \`${hit.snippet}\``);
      }
    }
  }

  lines.push('', '## Mapped Verification Commands');
  for (const cmd of analysis.commands || []) {
    lines.push(`- \`${cmd.label}\`${cmd.optionalRuntime ? ` (optional if \`${cmd.optionalRuntime}\` absent)` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function runVerificationPlan(analysis, options = {}) {
  const cwd = options.cwd || process.cwd();
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const results = [];
  let ok = true;

  for (const step of analysis.commands || []) {
    const res = spawnSyncFn(step.command, step.args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: options.stdio ?? 'inherit'
    });

    if (res.error && res.error.code === 'ENOENT' && step.optionalRuntime) {
      results.push({ label: step.label, status: 'skipped', code: null });
      continue;
    }

    const failed = Boolean(res.error) || res.status !== 0;
    results.push({
      label: step.label,
      status: failed ? 'failed' : 'passed',
      code: res.status ?? 1,
      error: res.error?.message
    });
    if (failed) {
      ok = false;
      if (options.failFast !== false) break;
    }
  }

  return { ok, results };
}

function main() {
  const args = parseInterrogateArgs(process.argv.slice(2));
  const diff = resolveDiff(args);
  const analysis = analyzeDiff({ files: diff.files, patch: diff.patch });

  if (args.json) {
    process.stdout.write(JSON.stringify({ mode: diff.mode, ...analysis }, null, 2) + '\n');
  } else if (args.brief || !args.run) {
    process.stdout.write(buildInterrogateBrief(analysis));
  }

  if (args.run) {
    const execution = runVerificationPlan(analysis);
    if (!execution.ok) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();

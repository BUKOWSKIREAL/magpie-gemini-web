import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseInterrogateArgs,
  resolveDiff,
  analyzeDiff,
  buildInterrogateBrief,
  runVerificationPlan
} from '../scripts/interrogate-diff.mjs';

const temps = [];
function makeTmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-interrogate-test-'));
  temps.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  return dir;
}

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Diff interrogation and subsystem verification planner', () => {
  it('parses CLI flags cleanly and rejects unknown flags', () => {
    assert.deepEqual(parseInterrogateArgs(['--base', 'origin/main', '--run', '--json']), {
      base: 'origin/main',
      staged: false,
      files: null,
      brief: false,
      json: true,
      run: true
    });
    assert.deepEqual(parseInterrogateArgs(['--files=lib/proc.mjs,scripts/release-plugin.mjs', '--brief']), {
      base: '',
      staged: false,
      files: ['lib/proc.mjs', 'scripts/release-plugin.mjs'],
      brief: true,
      json: false,
      run: false
    });
    assert.throws(() => parseInterrogateArgs(['--nope']), /Unknown argument/);
  });

  it('maps touched subsystems to test files and flags all 4 hazard categories on added non-test lines', () => {
    const patch = [
      'diff --git a/lib/proc.mjs b/lib/proc.mjs',
      '--- a/lib/proc.mjs',
      '+++ b/lib/proc.mjs',
      '@@ -10,0 +11,4 @@',
      '+execFileSync("ps", ["-p", String(pid)]);',
      '+if (processAlive(pid) && !zombie(pid)) {',
      '+  fs.writeFileSync("/tmp/test.lock", "x");',
      '+  await fetch("http://127.0.0.1:8080/health");',
      '+}',
      'diff --git a/test/zombie.test.mjs b/test/zombie.test.mjs',
      '--- a/test/zombie.test.mjs',
      '+++ b/test/zombie.test.mjs',
      '@@ -1,0 +2,1 @@',
      '+execFileSync("ignored-in-test-hazard-scan");'
    ].join('\n');

    const analysis = analyzeDiff({
      files: ['lib/proc.mjs', 'lib/studio-updates.mjs', 'index.mjs', 'test/zombie.test.mjs'],
      patch
    });

    assert.ok(analysis.subsystems.includes('proc-liveness'));
    assert.ok(analysis.subsystems.includes('studio-updates-lock'));
    assert.ok(analysis.subsystems.includes('studio-runtime'));
    assert.ok(analysis.testFiles.includes('test/zombie.test.mjs'));
    assert.ok(analysis.testFiles.includes('test/studio-lock-model.test.mjs'));
    assert.ok(analysis.testFiles.includes('test/studio-connect.test.mjs'));
    assert.ok(analysis.testFiles.includes('test/studio-connect-legacy.test.mjs'));

    const studioExtra = analyzeDiff({
      files: ['lib/studio.mjs', 'lib/studio-page.mjs', 'lib/native.mjs', 'lib/setup.mjs', 'lib/cite.mjs', 'lib/studio-connect.mjs'],
      patch: [
        'diff --git a/lib/cite.mjs b/lib/cite.mjs',
        '--- a/lib/cite.mjs',
        '+++ b/lib/cite.mjs',
        '@@ -1,0 +2,1 @@',
        '+++++fetch("http://localhost");'
      ].join('\n')
    });
    for (const expectedTest of [
      'test/studio.test.mjs',
      'test/studio-page.test.mjs',
      'test/native.test.mjs',
      'test/setup.test.mjs',
      'test/cite.test.mjs',
      'test/studio-connect.test.mjs',
      'test/studio-connect-legacy.test.mjs'
    ]) {
      assert.ok(studioExtra.testFiles.includes(expectedTest), `missing ${expectedTest}`);
    }
    assert.equal(studioExtra.hazards['network-auth-proxy'], 1);

    assert.equal(analysis.hazards['child-process'], 1);
    assert.equal(analysis.hazards['process-liveness'], 1);
    assert.equal(analysis.hazards['filesystem-lock-or-state'], 1);
    assert.equal(analysis.hazards['network-auth-proxy'], 1);
    assert.ok(analysis.commands.some(c => c.optionalRuntime === 'bun'));
    assert.equal(analysis.commands[0].label, 'node scripts/check-guardrails.mjs');
    assert.equal(analysis.commands.at(-1).label, 'npm pack --dry-run');

    const brief = buildInterrogateBrief(analysis);
    assert.match(brief, /Independent Diff Interrogation Brief/);
    assert.match(brief, /\*\*child-process\*\*/);
    assert.match(brief, /lib\/proc\.mjs:11/);
  });

  it('resolves both modified tracked files and newly created untracked files in a git repo', () => {
    const repo = makeTmpGitRepo();
    fs.writeFileSync(path.join(repo, 'lib-tracked.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'lib-tracked.mjs'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore', windowsHide: true });

    fs.writeFileSync(path.join(repo, 'lib-tracked.mjs'), 'export const x = 2;\nfetch("http://localhost");\n');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'new-tool.mjs'), 'writeFileSync("foo.lock", "y");\n');

    const diff = resolveDiff({ cwd: repo });
    assert.deepEqual(diff.files, ['lib-tracked.mjs', 'scripts/new-tool.mjs']);
    const analysis = analyzeDiff({ files: diff.files, patch: diff.patch, filterExisting: false });
    assert.equal(analysis.hazards['network-auth-proxy'], 1);
    assert.equal(analysis.hazards['filesystem-lock-or-state'], 1);
  });

  it('runs mapped commands via runVerificationPlan, tolerating missing optional bun and propagating real failures', () => {
    const analysis = analyzeDiff({
      files: ['lib/studio-native.mjs'],
      patch: '',
      filterExisting: false
    });

    const skippedOk = runVerificationPlan(analysis, {
      stdio: 'ignore',
      spawnSyncFn: cmd => (cmd === 'bun' ? { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), status: null } : { status: 0 })
    });
    assert.equal(skippedOk.ok, true);
    assert.equal(skippedOk.results.find(r => r.label.startsWith('bun test')).status, 'skipped');

    const failed = runVerificationPlan(analysis, {
      stdio: 'ignore',
      spawnSyncFn: (_cmd, args) => (args.includes('--test') ? { status: 1 } : { status: 0 })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.results.at(-1).status, 'failed');
  });
});

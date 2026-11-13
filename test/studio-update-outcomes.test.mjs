import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Exercise the shipped command's error/exit/cleanup handling without the network
// or a real backend. Only its native dependency is replaced in a disposable copy.
let root, script;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-update-outcomes-'));
  const native = path.join(root, 'native.mjs');
  fs.writeFileSync(native, `
    import fs from 'node:fs';
    import path from 'node:path';
    export async function ensureStudio({ dataDir }) {
      fs.writeFileSync(process.env.MAGPIE_UPDATER_TEST_DIR, dataDir);
      for (const file of ['config.json', 'install-manifest.json', 'backend']) fs.writeFileSync(path.join(dataDir, file), '{}');
      return { binaryPath: path.join(dataDir, 'backend') };
    }
    export async function studioAdmin(local, method, endpoint) {
      if (endpoint !== '/api/update') return {};
      if (method === 'POST') throw new Error(process.env.MAGPIE_UPDATER_TEST_ERROR);
      return { mode: 'binary', current: 'v0.3.6', latest: 'v0.3.7', available: process.env.MAGPIE_UPDATER_TEST_PHASE === 'apply', error: process.env.MAGPIE_UPDATER_TEST_ERROR };
    }
    export async function stopStudio() { return { stopped: process.env.MAGPIE_UPDATER_TEST_STOPPED !== 'false' }; }
    export function localStudio() { return {}; }
    export function computeFileHash() { return 'initial'; }
    export async function studioStatus() { throw new Error('unexpected status call'); }
    export const nodeFetch = fetch;
  `);
  const original = fs.readFileSync(new URL('../scripts/studio-update-smoke.mjs', import.meta.url), 'utf8');
  script = path.join(root, 'probe.mjs');
  fs.writeFileSync(script, original
    .replace("'../lib/studio-native.mjs'", JSON.stringify(pathToFileURL(native).href))
    .replace("'./studio-lifecycle-smoke.mjs'", JSON.stringify(new URL('../scripts/studio-lifecycle-smoke.mjs', import.meta.url).href)));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const limited = '读取最新发行版本: HTTP 403 {"message":"API rate limit exceeded for a shared runner"}';
describe('Official updater acceptance outcomes', () => {
  for (const [index, scenario] of [
    { name: 'ordinary CLI acceptance remains strict on rate limits', error: limited, status: 1 },
    { name: 'explicit CI mode distinguishes a deferred check from success', flag: true, error: limited, status: 75 },
    { name: 'rate limits during apply also stop and clean the test instance', flag: true, error: limited, phase: 'apply', status: 75 },
    { name: 'generic access errors are still failures', flag: true, error: 'HTTP 403 permission denied', status: 1 },
    { name: 'integrity failures are still failures', flag: true, error: 'SHA256 checksum mismatch', status: 1 },
    { name: 'an unconfirmed process exit overrides a deferred result', flag: true, error: limited, stopped: false, status: 1 }
  ].entries()) it(scenario.name, () => {
    const report = path.join(root, index + '.dir');
    const result = spawnSync(process.execPath, [script, ...(scenario.flag ? ['--defer-rate-limit'] : [])], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, MAGPIE_UPDATER_TEST_DIR: report, MAGPIE_UPDATER_TEST_ERROR: scenario.error,
        MAGPIE_UPDATER_TEST_PHASE: scenario.phase || 'check', MAGPIE_UPDATER_TEST_STOPPED: String(scenario.stopped !== false) }
    });
    const dataDir = fs.readFileSync(report, 'utf8');
    try {
      assert.equal(result.status, scenario.status, result.stderr);
      assert.ok(!result.stdout.includes('PASS real official online update'));
      assert.equal(fs.existsSync(dataDir), scenario.stopped === false, 'only a confirmed stop permits cleanup');
      if (scenario.status === 75) assert.match(result.stderr, /DEFERRED.*not a passed update test/);
    } finally {
      // The dependency is a stub; no process was ever started for this fixture.
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

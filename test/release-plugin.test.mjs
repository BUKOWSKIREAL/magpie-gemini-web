import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyPublishedPackage } from '../scripts/verify-published-package.mjs';
import { parseReleaseArgs, releasePlugin } from '../scripts/release-plugin.mjs';

const SHA_HEAD = 'da41186f0f2a31c3f1d0e87bf463fc73be4898b1';

function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function sha512Integrity(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

function makeTempPkg(t, version = '0.14.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-verify-pkg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'magpie-gemini-web',
    version,
    repository: { type: 'git', url: 'git+https://github.com/BUKOWSKIREAL/magpie-gemini-web.git' }
  }));
  return { dir, pkgPath };
}

function makeReleaseFixture({
  commit = SHA_HEAD,
  version = '0.14.1',
  dirty = false,
  ancestorOk = true,
  existingRelease = null,
  npmStatus = 404
} = {}) {
  const calls = [];
  const pkgJson = JSON.stringify({
    name: 'magpie-gemini-web',
    version,
    repository: { type: 'git', url: 'git+https://github.com/BUKOWSKIREAL/magpie-gemini-web.git' }
  });
  const backendReleaseJson = JSON.stringify({
    repository: 'BUKOWSKIREAL/magpie-gemini-web',
    tag: 'backend-v4.28.0-magpie.1',
    binaries: {
      'darwin-arm64': { asset: 'gemini-web2api-go_darwin_arm64', sha256: 'a'.repeat(64) },
      'linux-x64': { asset: 'gemini-web2api-go_linux_amd64', sha256: 'b'.repeat(64) }
    }
  });

  let releaseState = existingRelease ? structuredClone(existingRelease) : null;
  const runSeq = { publish: 0, verify: 0 };

  const execFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${commit}\n`, stderr: '' };
      if (args[0] === 'status') return { status: 0, stdout: dirty ? ' M index.mjs\n' : '', stderr: '' };
      if (args[0] === 'show' && args[1] === `${commit}:package.json`) return { status: 0, stdout: pkgJson, stderr: '' };
      if (args[0] === 'show' && args[1] === `${commit}:lib/backend-release.json`) return { status: 0, stdout: backendReleaseJson, stderr: '' };
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'merge-base') return { status: ancestorOk ? 0 : 1, stdout: '', stderr: '' };
    }
    if (cmd === 'gh') {
      if (args[0] === 'release' && args[1] === 'view') {
        if (!releaseState) return { status: 1, stdout: '', stderr: 'release not found' };
        return { status: 0, stdout: JSON.stringify(releaseState), stderr: '' };
      }
      if (args[0] === 'release' && args[1] === 'create') {
        releaseState = {
          isDraft: true,
          targetCommitish: commit,
          assets: [],
          url: `https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/v${version}`
        };
        return { status: 0, stdout: `${releaseState.url}\n`, stderr: '' };
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        releaseState.isDraft = false;
        return { status: 0, stdout: `${releaseState.url}\n`, stderr: '' };
      }
      if (args[0] === 'workflow' && args[1] === 'run') {
        if (args[2] === 'publish-package.yml') {
          runSeq.publish += 1;
          if (releaseState) {
            releaseState.assets.push({ name: `magpie-gemini-web-${version}.tgz`, state: 'uploaded' });
          }
        } else if (args[2] === 'verify-package.yml') {
          runSeq.verify += 1;
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'run' && args[1] === 'list') {
        const wf = args[args.indexOf('--workflow') + 1];
        const base = wf === 'publish-package.yml' ? 1000 : 2001;
        const seq = wf === 'publish-package.yml' ? runSeq.publish : runSeq.verify;
        const id = base + seq;
        return {
          status: 0,
          stdout: JSON.stringify(id > base || seq === 0 ? [{
            databaseId: id,
            createdAt: new Date(1000000).toISOString(),
            status: 'completed',
            conclusion: 'success',
            url: `https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/${id}`
          }] : []),
          stderr: ''
        };
      }
      if (args[0] === 'run' && args[1] === 'watch') {
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };

  const fetchFn = async (url, init = {}) => {
    const str = String(url);
    if (str.includes('/releases/download/')) {
      return new Response(init.method === 'HEAD' ? null : 'ok', { status: 200 });
    }
    if (str.endsWith(`/magpie-gemini-web/${version}`)) {
      return new Response(npmStatus === 200 ? '{}' : 'Not Found', { status: npmStatus });
    }
    throw new Error(`Unexpected fetch URL: ${str}`);
  };

  return { calls, execFn, fetchFn };
}

describe('verifyPublishedPackage', () => {
  it('retries stale npm packument dist-tags.latest until CDN converges', async t => {
    const { dir, pkgPath } = makeTempPkg(t, '0.14.1');
    const outDir = path.join(dir, 'out');
    const tarballBytes = Buffer.from('deterministic-tarball-bytes');
    let packumentReads = 0;

    const result = await verifyPublishedPackage({
      pkgPath,
      repository: 'BUKOWSKIREAL/magpie-gemini-web',
      outDir,
      attempts: 5,
      retryMs: 0,
      sleepFn: async () => {},
      log: () => {},
      fetchFn: async url => {
        const s = String(url);
        if (s === 'https://registry.npmjs.org/magpie-gemini-web/0.14.1') {
          return Response.json({
            name: 'magpie-gemini-web',
            version: '0.14.1',
            dist: {
              tarball: 'https://registry.npmjs.org/magpie-gemini-web/-/magpie-gemini-web-0.14.1.tgz',
              shasum: sha1Hex(tarballBytes),
              integrity: sha512Integrity(tarballBytes)
            }
          });
        }
        if (s.endsWith('.tgz')) return new Response(tarballBytes, { status: 200 });
        if (s === 'https://registry.npmjs.org/magpie-gemini-web') {
          packumentReads += 1;
          const latest = packumentReads < 3 ? '0.14.0' : '0.14.1';
          return Response.json({ 'dist-tags': { latest } });
        }
        throw new Error(`Unexpected URL: ${s}`);
      }
    });

    assert.equal(packumentReads, 3);
    assert.equal(result.latest, '0.14.1');
    assert.equal(result.exactBytesMatch, true);
    assert.deepEqual(fs.readFileSync(path.join(outDir, 'package.tgz')), tarballBytes);
  });

  it('fails clearly when dist-tags.latest never converges within attempts', async t => {
    const { dir, pkgPath } = makeTempPkg(t, '0.14.1');
    const tarballBytes = Buffer.from('same-bytes');

    await assert.rejects(verifyPublishedPackage({
      pkgPath,
      repository: 'BUKOWSKIREAL/magpie-gemini-web',
      outDir: path.join(dir, 'out'),
      attempts: 3,
      retryMs: 0,
      sleepFn: async () => {},
      log: () => {},
      fetchFn: async url => {
        const s = String(url);
        if (s.endsWith('/0.14.1')) {
          return Response.json({
            name: 'magpie-gemini-web',
            version: '0.14.1',
            dist: {
              tarball: 'https://registry.npmjs.org/magpie-gemini-web/-/magpie-gemini-web-0.14.1.tgz',
              shasum: sha1Hex(tarballBytes),
              integrity: sha512Integrity(tarballBytes)
            }
          });
        }
        if (s.endsWith('.tgz')) return new Response(tarballBytes, { status: 200 });
        return Response.json({ 'dist-tags': { latest: '0.14.0' } });
      }
    }), /dist-tags\.latest did not converge|0\.14\.0.*0\.14\.1/);
  });

  it('rejects byte mismatches between npm and GitHub tarballs', async t => {
    const { dir, pkgPath } = makeTempPkg(t, '0.14.1');
    const npmBytes = Buffer.from('npm-bytes');
    const ghBytes = Buffer.from('github-bytes');

    await assert.rejects(verifyPublishedPackage({
      pkgPath,
      repository: 'BUKOWSKIREAL/magpie-gemini-web',
      outDir: path.join(dir, 'out'),
      attempts: 2,
      retryMs: 0,
      sleepFn: async () => {},
      log: () => {},
      fetchFn: async url => {
        const s = String(url);
        if (s.endsWith('/0.14.1')) {
          return Response.json({
            name: 'magpie-gemini-web',
            version: '0.14.1',
            dist: {
              tarball: 'https://registry.npmjs.org/magpie-gemini-web/-/magpie-gemini-web-0.14.1.tgz',
              shasum: sha1Hex(npmBytes),
              integrity: sha512Integrity(npmBytes)
            }
          });
        }
        if (s.includes('registry.npmjs.org/magpie-gemini-web/-')) return new Response(npmBytes, { status: 200 });
        return new Response(ghBytes, { status: 200 });
      }
    }), /must match byte for byte/);
  });

  it('fails fast when registry metadata is missing dist.tarball', async t => {
    const { dir, pkgPath } = makeTempPkg(t, '0.14.1');
    let reads = 0;

    await assert.rejects(verifyPublishedPackage({
      pkgPath,
      repository: 'BUKOWSKIREAL/magpie-gemini-web',
      outDir: path.join(dir, 'out'),
      attempts: 3,
      retryMs: 0,
      sleepFn: async () => {},
      log: () => {},
      fetchFn: async () => {
        reads += 1;
        return Response.json({ name: 'magpie-gemini-web', version: '0.14.1', dist: {} });
      }
    }), /missing dist\.tarball/);
    assert.equal(reads, 1);
  });
});

describe('releasePlugin orchestrator', () => {
  it('rejects --allow-dirty unless --dry-run is set, and accepts markdown --notes', () => {
    assert.throws(() => parseReleaseArgs(['--allow-dirty']), /--allow-dirty is only permitted/);
    assert.equal(parseReleaseArgs(['--notes', '--- heading\nnotes']).notes, '--- heading\nnotes');
  });

  it('plans all steps in --dry-run without executing mutating gh or git fetch commands', async () => {
    const fixture = makeReleaseFixture({ dirty: true });
    const res = await releasePlugin({
      dryRun: true,
      allowDirty: true,
      generateNotes: true,
      execFn: fixture.execFn,
      fetchFn: fixture.fetchFn,
      nowFn: () => 1000000,
      sleepFn: async () => {},
      log: () => {}
    });

    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.steps.map(s => [s.action, s.status]), [
      ['create-draft-release', 'planned'],
      ['publish-package', 'planned'],
      ['undraft-release', 'planned'],
      ['git-fetch-tags', 'planned'],
      ['verify-package', 'planned']
    ]);
    assert.equal(fixture.calls.some(([c, a]) => c === 'gh' && ['create', 'edit', 'run'].includes(a)), false);
  });

  it('executes full fresh release end-to-end in exact order', async () => {
    const fixture = makeReleaseFixture({ npmStatus: 404 });
    const res = await releasePlugin({
      generateNotes: true,
      pollMs: 0,
      execFn: fixture.execFn,
      fetchFn: fixture.fetchFn,
      nowFn: () => 1000000,
      sleepFn: async () => {},
      log: () => {}
    });

    assert.equal(res.ok, true);
    assert.equal(res.tag, 'v0.14.1');
    assert.equal(res.publishRunUrl, 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/1001');
    assert.equal(res.verifyRunUrl, 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/2002');
    assert.deepEqual(res.steps.map(s => [s.action, s.status]), [
      ['create-draft-release', 'completed'],
      ['publish-package', 'completed'],
      ['undraft-release', 'completed'],
      ['git-fetch-tags', 'completed'],
      ['verify-package', 'completed']
    ]);
  });

  it('resumes idempotently when tarball and npm package already exist on an un-undrafted draft', async () => {
    const fixture = makeReleaseFixture({
      npmStatus: 200,
      existingRelease: {
        isDraft: true,
        targetCommitish: SHA_HEAD,
        assets: [{ name: 'magpie-gemini-web-0.14.1.tgz', state: 'uploaded' }],
        url: 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/v0.14.1'
      }
    });

    const res = await releasePlugin({
      pollMs: 0,
      execFn: fixture.execFn,
      fetchFn: fixture.fetchFn,
      nowFn: () => 1000000,
      sleepFn: async () => {},
      log: () => {}
    });

    assert.deepEqual(res.steps.map(s => [s.action, s.status]), [
      ['create-draft-release', 'skipped'],
      ['publish-package', 'skipped'],
      ['undraft-release', 'completed'],
      ['git-fetch-tags', 'completed'],
      ['verify-package', 'completed']
    ]);
    const dispatched = fixture.calls.filter(c => c[0] === 'gh' && c[1] === 'workflow' && c[2] === 'run');
    assert.deepEqual(dispatched, [
      ['gh', 'workflow', 'run', 'verify-package.yml', '--repo', 'BUKOWSKIREAL/magpie-gemini-web', '-f', 'ref=v0.14.1']
    ]);
  });

  it('tracks newly dispatched runs by databaseId even under large local clock skew', async () => {
    const fixture = makeReleaseFixture({ npmStatus: 404 });
    const res = await releasePlugin({
      generateNotes: true,
      pollMs: 0,
      execFn: fixture.execFn,
      fetchFn: fixture.fetchFn,
      nowFn: () => 9_999_999_999_999,
      sleepFn: async () => {},
      log: () => {}
    });
    assert.equal(res.ok, true);
    assert.equal(res.publishRunUrl, 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/1001');
    assert.equal(res.verifyRunUrl, 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/2002');
  });

  it('aborts before triggering workflows when existing release points to a different commit SHA', async () => {
    const fixture = makeReleaseFixture({
      existingRelease: {
        isDraft: true,
        targetCommitish: '0'.repeat(40),
        assets: [],
        url: 'https://github.com/BUKOWSKIREAL/magpie-gemini-web/releases/tag/v0.14.1'
      }
    });

    await assert.rejects(releasePlugin({
      execFn: fixture.execFn,
      fetchFn: fixture.fetchFn,
      nowFn: () => 1000000,
      sleepFn: async () => {},
      log: () => {}
    }), /targets 0{40}, expected da41186/);

    assert.equal(fixture.calls.some(c => c[0] === 'gh' && c[1] === 'workflow'), false);
  });
});

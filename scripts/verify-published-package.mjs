#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function printHelp() {
  console.log(`Verify published npm and GitHub release tarballs match byte for byte.

Usage:
  node scripts/verify-published-package.mjs [options]

Options:
  --pkg <path>         Path to package.json (default: package.json)
  --repo <owner/name>  GitHub repository (default: GITHUB_REPOSITORY or package.json repository)
  --out-dir <dir>      Directory to write package.tgz into (default: published-package)
  --attempts <n>       Maximum poll attempts per step (default: 20)
  --retry-ms <ms>      Delay between poll attempts in ms (default: 15000)
  -h, --help           Show this help
`);
}

function repoFromPackage(pkg) {
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const match = String(raw || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  return match ? match[1] : '';
}

export function parseVerifyArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (['--pkg', '--repo', '--out-dir', '--attempts', '--retry-ms'].includes(arg)) {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      if (arg === '--pkg') opts.pkgPath = next;
      else if (arg === '--repo') opts.repository = next;
      else if (arg === '--out-dir') opts.outDir = next;
      else if (arg === '--attempts') opts.attempts = Number(next);
      else if (arg === '--retry-ms') opts.retryMs = Number(next);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (opts.attempts !== undefined && (!Number.isInteger(opts.attempts) || opts.attempts < 1)) {
    throw new Error(`Invalid --attempts: ${opts.attempts}`);
  }
  if (opts.retryMs !== undefined && (!Number.isFinite(opts.retryMs) || opts.retryMs < 0)) {
    throw new Error(`Invalid --retry-ms: ${opts.retryMs}`);
  }
  return opts;
}

export async function verifyPublishedPackage({
  pkgPath = path.join(REPO_ROOT, 'package.json'),
  repository = process.env.GITHUB_REPOSITORY,
  registryBase = 'https://registry.npmjs.org',
  outDir = 'published-package',
  attempts = 15,
  retryMs = 10000,
  fetchFn = globalThis.fetch,
  sleepFn = delay,
  log = console.log
} = {}) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(typeof pkg.name === 'string' && pkg.name, 'package.json name is required');
  assert.ok(typeof pkg.version === 'string' && pkg.version, 'package.json version is required');

  const repo = repository || repoFromPackage(pkg);
  assert.match(String(repo || ''), /^[^/\s]+\/[^/\s]+$/, `GitHub repository is required (got "${repo || ''}")`);

  const registry = `${registryBase.replace(/\/+$/, '')}/${pkg.name}`;

  let info;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchFn(`${registry}/${pkg.version}`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        info = await response.json();
        break;
      }
      const status = response.status;
      await response.body?.cancel?.().catch(() => {});
      assert.ok(status === 404 || status >= 500, `Unexpected registry status ${status}`);
      log(`Registry status ${status}; waiting for ${pkg.name}@${pkg.version}`);
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      log(`Registry request failed: ${error.message}`);
    }
    if (attempt < attempts - 1) await sleepFn(retryMs);
  }
  assert.ok(info, 'Package did not become publicly available within the verification window');
  assert.equal(info.version, pkg.version);
  assert.equal(info.name, pkg.name);
  assert.ok(typeof info?.dist?.tarball === 'string' && info.dist.tarball, 'Registry version metadata missing dist.tarball');
  assert.ok(typeof info?.dist?.shasum === 'string' && info.dist.shasum, 'Registry version metadata missing dist.shasum');
  assert.ok(typeof info?.dist?.integrity === 'string' && info.dist.integrity, 'Registry version metadata missing dist.integrity');

  const githubUrl = `https://github.com/${repo}/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}.tgz`;
  const files = await Promise.all([info.dist.tarball, githubUrl].map(async url => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        const status = response.status;
        await response.body?.cancel?.().catch(() => {});
        assert.ok(status === 404 || status >= 500, `Unexpected download status ${status}: ${url}`);
        log(`Download status ${status}; waiting for ${url}`);
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
        log(`Download request failed: ${error.message}`);
      }
      if (attempt < attempts - 1) await sleepFn(retryMs);
    }
    throw new Error(`Public download did not become available: ${url}`);
  }));

  assert.ok(files[0].equals(files[1]), 'npm and GitHub tarballs must match byte for byte');
  assert.equal(crypto.createHash('sha1').update(files[0]).digest('hex'), info.dist.shasum);
  assert.equal(`sha512-${crypto.createHash('sha512').update(files[0]).digest('base64')}`, info.dist.integrity);

  let latestMatched = false;
  let lastLatest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const metadata = await fetchFn(registry, {
        headers: { 'cache-control': 'no-cache', accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (metadata.status === 404 || metadata.status >= 500) {
        const status = metadata.status;
        await metadata.body?.cancel?.().catch(() => {});
        log(`Packument status ${status}; waiting for dist-tags.latest=${pkg.version}`);
      } else {
        if (metadata.status !== 200) {
          const status = metadata.status;
          await metadata.body?.cancel?.().catch(() => {});
          assert.equal(status, 200, `Unexpected packument status ${status}`);
        }
        const packument = await metadata.json();
        lastLatest = packument?.['dist-tags']?.latest;
        if (lastLatest === pkg.version) {
          latestMatched = true;
          break;
        }
        log(`Packument dist-tags.latest is ${JSON.stringify(lastLatest)}; waiting for ${pkg.version}`);
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      log(`Packument request failed: ${error.message}`);
    }
    if (attempt < attempts - 1) await sleepFn(retryMs);
  }
  assert.equal(
    latestMatched ? pkg.version : lastLatest,
    pkg.version,
    'npm dist-tags.latest did not converge to the published version'
  );

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'package.tgz'), files[0]);
  }

  const summary = {
    version: pkg.version,
    latest: pkg.version,
    shasum: info.dist.shasum,
    integrity: info.dist.integrity,
    exactBytesMatch: true
  };
  log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const opts = parseVerifyArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  await verifyPublishedPackage(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installBackend, startBackend, getDataDir } from '../lib/native.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'backend-source');
const build = path.join(root, 'backend-build');
const pinned = '93d9b384b2453c495942080f5838b8e71d6c1e6f';

const command = process.argv[2];

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Argon local build currently supports macOS arm64 only.');
  }

  switch (command) {
    case 'build': {
      const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (head !== pinned) {
        throw new Error(`Git commit mismatch: expected ${pinned}, got ${head}`);
      }
      fs.mkdirSync(build, { recursive: true, mode: 0o700 });
      fs.chmodSync(build, 0o700);

      const binPath = path.join(build, 'gemini-web2api-go');
      execFileSync('go', [
        'build',
        '-trimpath',
        '-o',
        binPath,
        '.'
      ], { cwd: source, stdio: 'inherit' });

      fs.chmodSync(binPath, 0o700);
      const bytes = fs.readFileSync(binPath);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

      const manifest = {
        version: '4.21.0-argon.1',
        sourceCommit: pinned,
        sha256,
        platform: 'darwin',
        arch: 'arm64'
      };
      const manifestPath = path.join(build, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(manifestPath, 0o600);
      console.log(`Argon binary built: ${binPath} (SHA256: ${sha256})`);
      break;
    }
    case 'install': {
      const manifestPath = path.join(build, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Build manifest not found at ${manifestPath}. Run 'npm run backend:build:argon' first.`);
      }
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m.sourceCommit !== pinned) {
        throw new Error(`Manifest sourceCommit mismatch: expected ${pinned}, got ${m.sourceCommit}`);
      }
      if (m.platform !== 'darwin' || m.arch !== 'arm64') {
        throw new Error(`Platform/arch mismatch in manifest: ${m.platform}/${m.arch}`);
      }
      if (!/^[a-f0-9]{64}$/.test(m.sha256)) {
        throw new Error(`Invalid sha256 in manifest: ${m.sha256}`);
      }

      const binPath = path.join(build, 'gemini-web2api-go');
      if (!fs.existsSync(binPath)) {
        throw new Error(`Binary not found at ${binPath}. Run 'npm run backend:build:argon' first.`);
      }
      const bytes = fs.readFileSync(binPath);
      const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== m.sha256) {
        throw new Error(`Binary hash mismatch: expected ${m.sha256}, got ${actualHash}`);
      }

      await installBackend({
        expectedHash: m.sha256,
        url: 'local Argon build',
        fetchFn: async () => new Response(bytes, { status: 200 })
      });

      const dataDir = getDataDir();
      const argonBuildPath = path.join(dataDir, 'argon-build.json');
      fs.writeFileSync(argonBuildPath, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(argonBuildPath, 0o600);
      console.log(`Argon backend installed into ${dataDir}`);
      break;
    }
    case 'start': {
      const dataDir = getDataDir();
      const argonBuildPath = path.join(dataDir, 'argon-build.json');
      if (!fs.existsSync(argonBuildPath)) {
        throw new Error(`Argon build manifest not found at ${argonBuildPath}. Run 'npm run backend:install:argon' first.`);
      }
      const m = JSON.parse(fs.readFileSync(argonBuildPath, 'utf8'));
      if (m.sourceCommit !== pinned) {
        throw new Error(`Manifest sourceCommit mismatch: expected ${pinned}, got ${m.sourceCommit}`);
      }
      if (m.platform !== 'darwin' || m.arch !== 'arm64') {
        throw new Error(`Platform/arch mismatch in manifest: ${m.platform}/${m.arch}`);
      }
      if (!/^[a-f0-9]{64}$/.test(m.sha256)) {
        throw new Error(`Invalid sha256 in manifest: ${m.sha256}`);
      }

      startBackend({ expectedHash: m.sha256 });
      break;
    }
    default:
      console.error('Usage: node scripts/backend-argon.mjs <build|install|start>');
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});

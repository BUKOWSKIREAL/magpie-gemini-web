#!/usr/bin/env node
// Clean upstream commit -> managed archives, never a developer's dirty tree. Upstream's own
// distributor settings make the build managed: it reports this version, and its online updater
// neither checks GitHub nor installs, saying the plugin manages updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinPath = path.join(root, 'lib/studio-release.json');
const release = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
const args = process.argv.slice(2);
for (const arg of args) {
  if (!['--write-pins', '--verify'].includes(arg) && !arg.startsWith('--target=') && !arg.startsWith('--source=')) throw new Error(`Unknown argument: ${arg}`);
}
const writePins = args.includes('--write-pins');
const verify = args.includes('--verify');
const requested = args.find(arg => arg.startsWith('--target='))?.slice(9);
const target = requested === 'host' ? `${process.platform}-${process.arch}` : requested;
const platforms = { 'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'amd64'],
  'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'], 'win32-x64': ['windows', 'amd64'] };
if (target && !platforms[target]) throw new Error(`Unsupported target: ${target}`);
if (writePins && (target || verify)) throw new Error('--write-pins requires all targets without --verify');
const output = path.join(root, 'studio-build/release');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-build-'));
const source = path.join(scratch, 'source');
fs.mkdirSync(source);
const env = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '', GOEXPERIMENT: '',
  GOTOOLCHAIN: `go${release.goVersion}`, GOAMD64: 'v1', GOARM64: 'v8.0' };
for (const key of ['GOOS', 'GOARCH']) delete env[key];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const go = (argv, extra = {}) => execFileSync('go', argv, { cwd: source, env: { ...env, ...extra }, stdio: 'inherit' });
const npm = argv => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv,
  { cwd: path.join(source, 'web'), stdio: 'inherit', shell: process.platform === 'win32' });
const MANAGED_BY = 'magpie-gemini-web';
const flags = ['-mod=readonly', '-trimpath', '-buildvcs=false',
  `-ldflags=-s -w -X github.com/Mag1cFall/AIStudio2API/internal/app.version=v${release.version} -X github.com/Mag1cFall/AIStudio2API/internal/app.managedBy=${MANAGED_BY}`];

try {
  let upstream = args.find(arg => arg.startsWith('--source='))?.slice(9);
  if (upstream) {
    upstream = path.resolve(upstream);
    execFileSync('git', ['-C', upstream, 'cat-file', '-e', `${release.upstream.commit}^{commit}`]);
  } else {
    upstream = path.join(scratch, 'upstream');
    execFileSync('git', ['init', '-q', upstream]);
    execFileSync('git', ['-C', upstream, 'fetch', '--depth=1', release.upstream.repository, release.upstream.commit], { stdio: 'inherit' });
  }
  execFileSync('git', ['-C', upstream, 'archive', '--format=tar', `--output=${path.join(scratch, 'upstream.tar')}`, release.upstream.commit]);
  execFileSync('tar', ['-xf', 'upstream.tar', '-C', 'source'], { cwd: scratch });
  // The plugin tells whether a sign-in will download Camoufox by the version this upstream takes.
  const camoufox = fs.readFileSync(path.join(source, 'internal/camoufoxnative/download.go'), 'utf8')
    .match(/const camoufoxRelease = "([^"]+)"/)?.[1];
  if (!camoufox) throw new Error('Could not find camoufoxRelease in upstream internal/camoufoxnative/download.go');
  if (camoufox !== release.upstream.camoufox) {
    throw new Error(`Upstream takes Camoufox ${camoufox}: set upstream.camoufox in lib/studio-release.json to it (now ${release.upstream.camoufox})`);
  }
  npm(['ci', '--no-audit', '--no-fund']);
  npm(['run', 'lint']);
  npm(['run', 'build']);
  go(['test', '-mod=readonly', './cmd/...', './internal/...', '-count=1']);
  const binaries = {};
  for (const key of target ? [target] : Object.keys(platforms)) {
    const [goos, goarch] = platforms[key];
    const binary = path.join(scratch, goos === 'windows' ? 'aistudio2api.exe' : 'aistudio2api');
    const asset = `aistudio2api-v${release.version}-${goos}-${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
    console.log(`Building ${key}: ${asset}`);
    go(['build', ...flags, '-o', binary, './cmd/aistudio2api'], { GOOS: goos, GOARCH: goarch });
    go(['run', path.join(root, 'scripts/studio-archive.go'), path.join(output, asset), binary, path.join(source, 'LICENSE')]);
    const sha256 = hash(path.join(output, asset));
    const binarySha256 = hash(binary);
    if (verify && (release.binaries[key]?.sha256 !== sha256 || release.binaries[key]?.binarySha256 !== binarySha256 || release.binaries[key]?.asset !== asset)) {
      throw new Error(`Release pin mismatch for ${key}: ${sha256}`);
    }
    binaries[key] = { asset, sha256, binarySha256 };
  }
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-AISTUDIO'));
  fs.writeFileSync(path.join(output, target ? `build-${target}.json` : 'build.json'), JSON.stringify({
    version: release.version, upstream: release.upstream, goVersion: release.goVersion,
    nodeVersion: process.version, managedBy: MANAGED_BY, flags, binaries
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, target ? `SHA256SUMS-${target}.txt` : 'SHA256SUMS.txt'),
    Object.values(binaries).map(pin => `${pin.sha256}  ${pin.asset}\n`).join(''));
  if (writePins) fs.writeFileSync(pinPath, JSON.stringify({ ...release, binaries }, null, 2) + '\n');
  console.log(`Managed Studio archives ready: ${output}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

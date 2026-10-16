#!/usr/bin/env node
// Build from a clean, pinned upstream tree plus the checked-in patch. The developer's
// backend-source working tree is never changed or included in release artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinPath = path.join(root, 'lib/backend-release.json');
const release = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
const args = process.argv.slice(2);
const writePins = args.includes('--write-pins');
const verify = args.includes('--verify');
const requested = args.find(arg => arg.startsWith('--target='))?.slice('--target='.length);
for (const arg of args) {
  if (!['--write-pins', '--verify'].includes(arg) && !arg.startsWith('--target=')) throw new Error(`Unknown argument: ${arg}`);
}
const platforms = {
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'amd64'],
  'linux-x64': ['linux', 'amd64'],
  'linux-arm64': ['linux', 'arm64'],
  'win32-x64': ['windows', 'amd64'],
  'win32-arm64': ['windows', 'arm64']
};
const target = requested === 'host' ? `${process.platform}-${process.arch}` : requested;
if (target && !platforms[target]) throw new Error(`Unsupported target: ${target}`);
if (writePins && (target || verify)) throw new Error('--write-pins requires a full build without --verify');
const targets = target ? [target] : Object.keys(platforms);
const output = path.join(root, 'backend-build', 'release');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-backend-build-'));
const source = path.join(scratch, 'source');
fs.mkdirSync(source);
const env = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '', GOEXPERIMENT: '',
  GOTOOLCHAIN: `go${release.goVersion}`, GOAMD64: 'v1', GOARM64: 'v8.0' };
for (const name of ['ARGON_PROBE_COOKIE', 'GW2A_UPLOAD_PROBE', 'SQL_DSN', 'GOOS', 'GOARCH']) delete env[name];
const go = (argv, extraEnv = {}) => execFileSync('go', argv, { cwd: source, env: { ...env, ...extraEnv }, stdio: 'inherit' });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const patchPath = path.join(root, 'patches/argon.patch');
const flags = ['-trimpath', '-buildvcs=false', '-ldflags=-s -w'];

try {
  let upstream = path.join(root, 'backend-source');
  try {
    execFileSync('git', ['-C', upstream, 'cat-file', '-e', `${release.upstream.commit}^{commit}`], { stdio: 'pipe' });
  } catch {
    upstream = path.join(scratch, 'upstream');
    execFileSync('git', ['init', '-q', upstream]);
    execFileSync('git', ['-C', upstream, 'fetch', '--depth=1', release.upstream.repository, release.upstream.commit], { stdio: 'inherit' });
  }
  const archive = path.join(scratch, 'upstream.tar');
  execFileSync('git', ['-C', upstream, 'archive', '--format=tar', `--output=${archive}`, release.upstream.commit]);
  execFileSync('tar', ['-xf', archive, '-C', source]);
  execFileSync('git', ['apply', '--check', patchPath], { cwd: source, stdio: 'inherit' });
  execFileSync('git', ['apply', patchPath], { cwd: source, stdio: 'inherit' });
  const versionPath = path.join(source, 'internal/app/server.go');
  const server = fs.readFileSync(versionPath, 'utf8');
  const versionLine = /^const Version = "[^"]+"$/m;
  if (!versionLine.test(server)) throw new Error('Backend version declaration not found');
  fs.writeFileSync(versionPath, server.replace(versionLine, `const Version = ${JSON.stringify(release.version)}`));
  console.log(`Testing ${release.version} from ${release.upstream.commit} with patches/argon.patch`);
  go(['version']);
  go(['test', './...', '-count=1']);

  const binaries = {};
  for (const key of targets) {
    const [goos, goarch] = platforms[key];
    const asset = `gemini-web2api-go_v${release.version}_${goos}_${goarch}${goos === 'windows' ? '.exe' : ''}`;
    const file = path.join(output, asset);
    console.log(`Building ${key}: ${asset}`);
    go(['build', ...flags, '-o', file, '.'], { GOOS: goos, GOARCH: goarch });
    const bytes = fs.readFileSync(file);
    const sha256 = hash(bytes);
    if (verify && (release.binaries[key]?.sha256 !== sha256 || release.binaries[key]?.asset !== asset)) {
      throw new Error(`Release pin mismatch for ${key}: built ${sha256}`);
    }
    binaries[key] = { asset, sha256 };
    if (key === `${process.platform}-${process.arch}`) {
      const version = execFileSync(file, ['--version'], { encoding: 'utf8' }).trim();
      if (version !== `gemini-web2api-go ${release.version}`) throw new Error(`Unexpected binary version: ${version}`);
      console.log(version);
    }
  }

  if (!target) {
    const sourceName = `gemini-web2api-go_v${release.version}_source.tar.gz`;
    execFileSync('tar', ['-czf', path.join(output, sourceName), '-C', source, '.']);
    fs.copyFileSync(path.join(root, 'LICENSE-UPSTREAM'), path.join(output, 'LICENSE-UPSTREAM'));
    const build = { version: release.version, upstream: release.upstream, goVersion: release.goVersion,
      patch: 'patches/argon.patch', patchSha256: hash(fs.readFileSync(patchPath)),
      versionOverride: release.version, cgoEnabled: false, flags, binaries };
    fs.writeFileSync(path.join(output, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
    const assets = [...Object.values(binaries).map(b => b.asset), sourceName, 'LICENSE-UPSTREAM', 'build.json'].sort();
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(name => `${hash(fs.readFileSync(path.join(output, name)))}  ${name}\n`).join(''));
    if (writePins) fs.writeFileSync(pinPath, `${JSON.stringify({ ...release, binaries }, null, 2)}\n`);
  }
  console.log(`Release artifacts ready: ${output}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

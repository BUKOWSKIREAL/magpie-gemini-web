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
if (writePins && verify) throw new Error('--write-pins cannot be combined with --verify');
const output = path.join(root, 'studio-build/release');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-build-'));
const source = path.join(scratch, 'source');
fs.mkdirSync(source);
const env = { ...process.env, CGO_ENABLED: '1', GOFLAGS: '', GOEXPERIMENT: '',
  GOTOOLCHAIN: `go${release.goVersion}`, GOAMD64: 'v1', GOARM64: 'v8.0' };
for (const key of ['GOOS', 'GOARCH', 'CC', 'CXX', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_LDFLAGS', 'MACOSX_DEPLOYMENT_TARGET']) delete env[key];
// SQLite now needs C. Linux uses Zig/musl; Windows uses MinGW GCC; macOS needs Apple's SDK.
const zig = process.env.STUDIO_ZIG || 'zig';
const compiler = {};
function cToolchain(key) {
  const [goos, goarch] = platforms[key];
  if (goos === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('Build macOS archives on macOS with Xcode command-line tools');
    compiler[key] = { version: execFileSync('clang', ['--version'], { encoding: 'utf8' }).trim(),
      sdk: execFileSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).trim() };
    return { CC: 'clang', MACOSX_DEPLOYMENT_TARGET: '13.0', CGO_CFLAGS: '-O2 -g -mmacosx-version-min=13.0', CGO_LDFLAGS: '-O2 -g -mmacosx-version-min=13.0' };
  }
  if (goos === 'windows') {
    const cc = process.env.STUDIO_MINGW_CC || (process.platform === 'win32' ? 'gcc' : 'x86_64-w64-mingw32-gcc');
    compiler[key] = { version: execFileSync(cc, ['--version'], { encoding: 'utf8' }).trim(),
      target: execFileSync(cc, ['-dumpmachine'], { encoding: 'utf8' }).trim() };
    if (compiler[key].target !== 'x86_64-w64-mingw32') throw new Error('Windows requires x86_64-w64-mingw32 GCC');
    return { CC: `"${cc}"`, CGO_CFLAGS: '-O2 -g', CGO_LDFLAGS: '-O2 -g' };
  }
  const version = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
  if (version !== release.zigVersion) throw new Error(`Expected Zig ${release.zigVersion}, got ${version}`);
  const triple = `${goarch === 'amd64' ? 'x86_64' : 'aarch64'}-linux-musl`;
  compiler[key] = `zig ${version} cc -target ${triple}`;
  return { CC: `"${zig}" cc -target ${triple}`, CGO_CFLAGS: '-O2 -g',
    CGO_LDFLAGS: '-O2 -g' };
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const go = (argv, extra = {}) => execFileSync('go', argv, { cwd: source, env: { ...env, ...extra }, stdio: 'inherit' });
const npm = argv => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv,
  { cwd: path.join(source, 'web'), stdio: 'inherit', shell: process.platform === 'win32' });
const MANAGED_BY = 'magpie-gemini-web';
const managedFlags = `-s -w -X github.com/Mag1cFall/AIStudio2API/internal/app.version=v${release.version} -X github.com/Mag1cFall/AIStudio2API/internal/app.managedBy=${MANAGED_BY}`;
function linkFlags(goos) {
  return goos === 'linux' ? "-linkmode external -extldflags '-static -Wl,--strip-all'"
    : goos === 'windows' ? "-linkmode external -extldflags '-static -Wl,--no-insert-timestamp'" : '';
}
const buildRecords = {};

try {
  const hostToolchain = cToolchain(`${process.platform}-${process.arch}`);
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
  const patches = (release.patches || []).map(name => {
    const file = path.join(root, 'patches', name);
    execFileSync('git', ['apply', '--check', file], { cwd: source, stdio: 'inherit' });
    execFileSync('git', ['apply', file], { cwd: source, stdio: 'inherit' });
    return { name, sha256: hash(file) };
  });
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
  // Node's gzip differs between builders; Go's is the same everywhere (see studio-regzip.go).
  go(['run', path.join(root, 'scripts/studio-regzip.go'), path.join(source, 'internal/webui/dist')]);
  go(['test', '-mod=readonly', `-ldflags=${linkFlags(process.platform === 'win32' ? 'windows' : process.platform)}`, './cmd/...', './internal/...', '-count=1'], hostToolchain);
  const binaries = {};
  for (const key of target ? [target] : Object.keys(platforms)) {
    const [goos, goarch] = platforms[key];
    const binary = path.join(scratch, goos === 'windows' ? 'aistudio2api.exe' : 'aistudio2api');
    const asset = `aistudio2api-v${release.version}-${goos}-${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
    console.log(`Building ${key}: ${asset}`);
    const buildFlags = ['-mod=readonly', '-trimpath', '-buildvcs=false',
      `-ldflags=${managedFlags} ${linkFlags(goos)}`, ...(goos === 'linux' ? ['-tags=netgo,osusergo'] : [])];
    const toolchain = cToolchain(key);
    buildRecords[key] = { flags: buildFlags, ...toolchain };
    go(['build', ...buildFlags, '-o', binary, './cmd/aistudio2api'], { ...toolchain, GOOS: goos, GOARCH: goarch });
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
    nodeVersion: process.version, managedBy: MANAGED_BY, builds: buildRecords, compiler, patches, binaries
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, target ? `SHA256SUMS-${target}.txt` : 'SHA256SUMS.txt'),
    Object.values(binaries).map(pin => `${pin.sha256}  ${pin.asset}\n`).join(''));
  if (writePins) fs.writeFileSync(pinPath, JSON.stringify({ ...release, binaries: { ...release.binaries, ...binaries } }, null, 2) + '\n');
  console.log(`Managed Studio archives ready: ${output}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

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
// Pins are only as good as the toolchain that made them: checking or writing them needs the pinned one.
const strict = writePins || verify;
const platforms = { 'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'amd64'],
  'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'], 'win32-x64': ['windows', 'amd64'] };
// --target=host, one target, or a comma-separated list; all targets without it.
const requested = args.find(arg => arg.startsWith('--target='))?.slice(9);
const targets = requested ? requested.split(',').map(key => key === 'host' ? `${process.platform}-${process.arch}` : key)
  : Object.keys(platforms);
for (const key of targets) if (!platforms[key]) throw new Error(`Unsupported target: ${key}`);
if (new Set(targets).size !== targets.length) throw new Error(`Duplicate target in --target=${requested}`);
if (writePins && verify) throw new Error('--write-pins cannot be combined with --verify');
const output = path.join(root, 'studio-build/release');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-build-'));
const source = path.join(scratch, 'source');
fs.mkdirSync(source);
const env = { ...process.env, CGO_ENABLED: '1', GOFLAGS: '', GOEXPERIMENT: '',
  GOTOOLCHAIN: `go${release.goVersion}`, GOAMD64: 'v1', GOARM64: 'v8.0' };
for (const key of ['GOOS', 'GOARCH', 'CC', 'CXX', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_LDFLAGS', 'MACOSX_DEPLOYMENT_TARGET']) delete env[key];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// SQLite now needs C, so the C toolchain is part of the pin (lib/studio-release.json "toolchains").
// Zig (Linux/musl) and llvm-mingw (Windows/UCRT) are cross compilers whose output does not depend on
// the machine they run on, so any builder reproduces those archives. Apple's linker and SDK are only
// on macOS and differ between Xcode releases, so macOS archives match only under the pinned Xcode.
const toolchains = release.toolchains;
const zig = process.env.STUDIO_ZIG || 'zig';
function pinned(what, actual, expected, hint) {
  if (actual === expected) return;
  const message = `${what} is ${actual || 'unknown'}, but the pins were made with ${expected}. ${hint}`;
  if (strict) throw new Error(message);
  console.warn(`warning: ${message}`);
}
// llvmMingw returns the pinned llvm-mingw's x86_64 compiler, fetched once into studio-build/toolchains
// and checked against its pinned SHA-256, unless STUDIO_MINGW_CC names one.
function llvmMingw() {
  if (process.env.STUDIO_MINGW_CC) return process.env.STUDIO_MINGW_CC;
  const pin = toolchains.llvmMingw;
  const host = process.platform === 'darwin' ? 'darwin' : `${process.platform}-${process.arch}`;
  const archive = pin.hosts[host];
  if (!archive) throw new Error(`No pinned llvm-mingw for ${host}: set STUDIO_MINGW_CC to llvm-mingw ${pin.version}'s x86_64-w64-mingw32-clang`);
  const cacheDir = path.join(root, 'studio-build/toolchains');
  const name = archive.asset.replace(/\.(tar\.xz|zip)$/, '');
  const home = path.join(cacheDir, name);
  const cc = path.join(home, 'bin', `x86_64-w64-mingw32-clang${process.platform === 'win32' ? '.exe' : ''}`);
  const stamp = path.join(home, '.sha256');
  if (fs.existsSync(cc) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === archive.sha256) return cc;
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheDir, '.fetch-'));
  try {
    const file = path.join(staging, archive.asset);
    const url = `https://github.com/mstorsjo/llvm-mingw/releases/download/${pin.version}/${archive.asset}`;
    console.log(`Fetching pinned llvm-mingw: ${url}`);
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--output', file, url], { stdio: 'inherit' });
    const sha256 = hash(file);
    if (sha256 !== archive.sha256) throw new Error(`${archive.asset} has SHA-256 ${sha256}, not the pinned ${archive.sha256}`);
    // Windows' own bsdtar reads zip; the GNU tar Git Bash puts ahead of it on PATH does not.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', file, '-C', staging], { stdio: 'inherit' });
    fs.writeFileSync(path.join(staging, name, '.sha256'), `${archive.sha256}\n`);
    fs.renameSync(path.join(staging, name), home);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return cc;
}
function xcode() {
  try {
    const [version, build] = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim().split('\n');
    return `${version.replace(/^Xcode /, '')} (${build.replace(/^Build version /, '')})`;
  } catch {
    return null; // Command-line tools alone have no xcodebuild.
  }
}
// cToolchain returns the C settings for a target and what they were made with. Only the targets
// being built and pinned must use the pinned toolchain; the host's is also used for upstream tests.
function cToolchain(key, { pin = false } = {}) {
  const check = pin ? pinned : () => {};
  const [goos, goarch] = platforms[key];
  if (goos === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('Build macOS archives on macOS with Xcode');
    const expected = `${toolchains.xcode.version} (${toolchains.xcode.build})`;
    const actual = xcode();
    check('Xcode', actual, expected,
      `Select it with DEVELOPER_DIR=/Applications/Xcode_${toolchains.xcode.version}.app/Contents/Developer, or let CI make macOS pins (docs/studio-release.md).`);
    const compiler = { xcode: actual, sdk: execFileSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).trim(),
      clang: execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0] };
    return { compiler, env: { CC: 'clang', MACOSX_DEPLOYMENT_TARGET: '13.0',
      CGO_CFLAGS: '-O2 -g -mmacosx-version-min=13.0', CGO_LDFLAGS: '-O2 -g -mmacosx-version-min=13.0' } };
  }
  if (goos === 'windows') {
    const cc = llvmMingw();
    const clang = execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0];
    const target = execFileSync(cc, ['-dumpmachine'], { encoding: 'utf8' }).trim();
    if (target !== 'x86_64-w64-windows-gnu') throw new Error(`Windows needs llvm-mingw's x86_64 clang, ${cc} targets ${target}`);
    check('Windows C compiler', clang, toolchains.llvmMingw.clang,
      `Unset STUDIO_MINGW_CC to use the pinned llvm-mingw ${toolchains.llvmMingw.version}.`);
    return { compiler: { llvmMingw: toolchains.llvmMingw.version, clang },
      env: { CC: `"${cc}"`, CGO_CFLAGS: '-O2 -g', CGO_LDFLAGS: '-O2 -g' } };
  }
  const version = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
  check('Zig', version, toolchains.zig, 'Install it, or point STUDIO_ZIG at it.');
  const triple = `${goarch === 'amd64' ? 'x86_64' : 'aarch64'}-linux-musl`;
  return { compiler: { zig: version, target: triple },
    env: { CC: `"${zig}" cc -target ${triple}`, CGO_CFLAGS: '-O2 -g', CGO_LDFLAGS: '-O2 -g' } };
}
const go = (argv, extra = {}) => execFileSync('go', argv, { cwd: source, env: { ...env, ...extra }, stdio: 'inherit' });
const npm = argv => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv,
  { cwd: path.join(source, 'web'), stdio: 'inherit', shell: process.platform === 'win32' });
const MANAGED_BY = 'magpie-gemini-web';
// An empty build ID: Go's default one hashes the build's inputs, the C compiler's path among them,
// so two builders' otherwise identical executables would differ in it.
const managedFlags = `-s -w -buildid= -X github.com/Mag1cFall/AIStudio2API/internal/app.version=v${release.version} -X github.com/Mag1cFall/AIStudio2API/internal/app.managedBy=${MANAGED_BY}`;
function linkFlags(goos) {
  return goos === 'linux' ? "-linkmode external -extldflags '-static -Wl,--strip-all'"
    : goos === 'windows' ? "-linkmode external -extldflags '-static -Wl,--no-insert-timestamp'" : '';
}
const buildRecords = {};
const compilers = {};

try {
  // Check every target's toolchain before the slow part, so a wrong one fails in seconds.
  for (const key of targets) cToolchain(key, { pin: true });
  const hostToolchain = cToolchain(`${process.platform}-${process.arch}`).env;
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
  const mismatches = [];
  for (const key of targets) {
    const [goos, goarch] = platforms[key];
    const binary = path.join(scratch, goos === 'windows' ? 'aistudio2api.exe' : 'aistudio2api');
    const asset = `aistudio2api-v${release.version}-${goos}-${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
    console.log(`Building ${key}: ${asset}`);
    const buildFlags = ['-mod=readonly', '-trimpath', '-buildvcs=false',
      `-ldflags=${managedFlags} ${linkFlags(goos)}`, ...(goos === 'linux' ? ['-tags=netgo,osusergo'] : [])];
    const toolchain = cToolchain(key);
    buildRecords[key] = { flags: buildFlags, ...toolchain.env };
    compilers[key] = toolchain.compiler;
    go(['build', ...buildFlags, '-o', binary, './cmd/aistudio2api'], { ...toolchain.env, GOOS: goos, GOARCH: goarch });
    go(['run', path.join(root, 'scripts/studio-archive.go'), path.join(output, asset), binary, path.join(source, 'LICENSE')]);
    const sha256 = hash(path.join(output, asset));
    const binarySha256 = hash(binary);
    const pin = release.binaries[key];
    if (verify && (pin?.sha256 !== sha256 || pin?.binarySha256 !== binarySha256 || pin?.asset !== asset)) {
      mismatches.push(`${key}: built ${asset} ${sha256} (executable ${binarySha256}), pinned ${pin?.asset} ${pin?.sha256} (executable ${pin?.binarySha256})`);
    }
    binaries[key] = { asset, sha256, binarySha256 };
  }
  // Written even when verification fails: the record says what made the archives that differ.
  const single = targets.length === 1 ? `-${targets[0]}` : '';
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-AISTUDIO'));
  fs.writeFileSync(path.join(output, `build${single}.json`), JSON.stringify({
    version: release.version, upstream: release.upstream, goVersion: release.goVersion, toolchains,
    nodeVersion: process.version, managedBy: MANAGED_BY, builds: buildRecords, compiler: compilers, patches, binaries
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, `SHA256SUMS${single}.txt`),
    Object.values(binaries).map(pin => `${pin.sha256}  ${pin.asset}\n`).join(''));
  if (mismatches.length) throw new Error(`Release pin mismatch:\n  ${mismatches.join('\n  ')}`);
  if (writePins) fs.writeFileSync(pinPath, JSON.stringify({ ...release, binaries: { ...release.binaries, ...binaries } }, null, 2) + '\n');
  console.log(`Managed Studio archives ready: ${output}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

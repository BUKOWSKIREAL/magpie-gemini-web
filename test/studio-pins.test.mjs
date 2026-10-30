import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergePins } from '../scripts/studio-pins.mjs';

const release = JSON.parse(fs.readFileSync(new URL('../lib/studio-release.json', import.meta.url), 'utf8'));
const patchHashes = Object.fromEntries(release.patches.map(name => [name, 'a'.repeat(64)]));
const sha = digit => digit.repeat(64);

// record is what one candidate runner's --target=host --write-pins writes as build-<target>.json.
function record(key, digit, overrides = {}) {
  const [platform, arch] = key.split('-');
  const goos = platform === 'win32' ? 'windows' : platform;
  const goarch = arch === 'x64' ? 'amd64' : arch;
  return {
    file: `candidate/build-${key}.json`,
    record: {
      version: release.version, upstream: release.upstream, goVersion: release.goVersion, toolchains: release.toolchains,
      patches: release.patches.map(name => ({ name, sha256: patchHashes[name] })),
      binaries: { [key]: { asset: `aistudio2api-v${release.version}-${goos}-${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`,
        sha256: sha(digit), binarySha256: sha(digit === 'f' ? 'e' : 'f') } },
      ...overrides
    }
  };
}
const targets = Object.keys(release.binaries);
const all = () => targets.map((key, i) => record(key, String(i + 1)));

it('pins every target from one candidate record each, keeping the pin file order', () => {
  const merged = mergePins(release, all().reverse(), patchHashes);
  assert.deepEqual(Object.keys(merged.binaries), targets);
  targets.forEach((key, i) => assert.equal(merged.binaries[key].sha256, sha(String(i + 1))));
  assert.deepEqual({ ...merged, binaries: release.binaries }, release, 'only binaries change');
});

it('refuses a missing or duplicated target', () => {
  assert.throws(() => mergePins(release, all().slice(1), patchHashes), new RegExp(`No build record for ${targets[0]}`));
  assert.throws(() => mergePins(release, [...all(), record(targets[0], '9')], patchHashes), /more than one build record/);
});

it('refuses records built from another source, patch, Go or toolchain', () => {
  const otherToolchains = { ...release.toolchains, xcode: { ...release.toolchains.xcode, version: '0.0' } };
  for (const [overrides, error] of [
    [{ version: '0.0.0-magpie.1' }, /built version/],
    [{ upstream: { ...release.upstream, commit: '0'.repeat(40) } }, /another upstream/],
    [{ goVersion: '1.0' }, /built with Go/],
    [{ toolchains: otherToolchains }, /other pinned toolchains/],
    [{ patches: [] }, /other patches/]
  ]) {
    const records = all();
    records[2] = record(targets[2], '3', overrides);
    assert.throws(() => mergePins(release, records, patchHashes), error);
  }
});

it('pins the C toolchains, including a checked llvm-mingw for each builder host', () => {
  assert.match(release.toolchains.zig, /^\d+\.\d+\.\d+$/);
  assert.match(release.toolchains.xcode.version, /^\d+\.\d+(\.\d+)?$/);
  assert.match(release.toolchains.xcode.build, /^\w+$/);
  const { version, clang, hosts } = release.toolchains.llvmMingw;
  assert.match(clang, /^clang version \d+\.\d+\.\d+ /);
  assert.deepEqual(Object.keys(hosts).sort(), ['darwin', 'linux-x64', 'win32-x64']);
  for (const { asset, sha256 } of Object.values(hosts)) {
    assert.ok(asset.startsWith(`llvm-mingw-${version}-ucrt-`), asset);
    assert.match(sha256, /^[0-9a-f]{64}$/);
  }
});

it('pins upstream\'s SpiderMonkey libraries for every target', () => {
  const { release: tag, repository, targets: libs } = release.toolchains.spidermonkey;
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.deepEqual(Object.keys(libs), Object.keys(release.binaries));
  const upstreamTargets = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-amd64', 'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-arm64', 'win32-x64': 'windows-amd64' };
  for (const [key, { asset, sha256 }] of Object.entries(libs)) {
    assert.equal(asset, `spidermonkey-${tag}-${upstreamTargets[key]}.tar.gz`);
    assert.match(sha256, /^[0-9a-f]{64}$/);
  }
});

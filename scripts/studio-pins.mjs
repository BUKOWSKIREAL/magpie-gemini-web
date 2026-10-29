#!/usr/bin/env node
// Candidate build records -> lib/studio-release.json binaries. A candidate run of
// .github/workflows/studio.yml builds each target on its own runner with --write-pins; this takes
// the build-<target>.json files those runners upload and pins all five targets at once.
// Usage: node scripts/studio-pins.mjs candidates/*/build-*.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinPath = path.join(root, 'lib/studio-release.json');

// mergePins returns release with the binaries the records built. Each record must come from this
// release's source, patches and toolchains, and each target from exactly one record.
export function mergePins(release, records, patchHashes) {
  const patches = release.patches.map(name => ({ name, sha256: patchHashes[name] }));
  const built = {};
  for (const { file, record } of records) {
    assert.equal(record.version, release.version, `${file}: built version ${record.version}`);
    assert.deepEqual(record.upstream, release.upstream, `${file}: built from another upstream`);
    assert.equal(record.goVersion, release.goVersion, `${file}: built with Go ${record.goVersion}`);
    assert.deepEqual(record.toolchains, release.toolchains, `${file}: built with other pinned toolchains`);
    assert.deepEqual(record.patches, patches, `${file}: built with other patches`);
    for (const [key, pin] of Object.entries(record.binaries)) {
      assert.ok(key in release.binaries, `${file}: unknown target ${key}`);
      assert.ok(!(key in built), `${key} is in more than one build record`);
      assert.match(pin.asset, new RegExp(`^aistudio2api-v${release.version.replaceAll('.', '\\.')}-`), `${file}: ${key} asset ${pin.asset}`);
      for (const field of ['sha256', 'binarySha256']) assert.match(pin[field], /^[0-9a-f]{64}$/, `${file}: ${key} ${field}`);
      built[key] = { asset: pin.asset, sha256: pin.sha256, binarySha256: pin.binarySha256 };
    }
  }
  const missing = Object.keys(release.binaries).filter(key => !(key in built));
  assert.deepEqual(missing, [], `No build record for ${missing.join(', ')}`);
  return { ...release, binaries: Object.fromEntries(Object.keys(release.binaries).map(key => [key, built[key]])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Usage: node scripts/studio-pins.mjs <build-record.json>...');
  const release = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  const patchHashes = Object.fromEntries(release.patches.map(name => [name,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'patches', name))).digest('hex')]));
  const records = files.map(file => ({ file, record: JSON.parse(fs.readFileSync(file, 'utf8')) }));
  const merged = mergePins(release, records, patchHashes);
  fs.writeFileSync(pinPath, JSON.stringify(merged, null, 2) + '\n');
  for (const [key, pin] of Object.entries(merged.binaries)) console.log(`${key}: ${pin.sha256}  ${pin.asset}`);
}

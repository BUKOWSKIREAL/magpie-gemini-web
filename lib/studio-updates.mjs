import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  studioDataDir, studioAutoUpdates, studioProcessStarted, withStudioUpdate,
  localStudio, checkStudioHealth, studioAdmin, installStudio, computeFileHash, downloadProxy
} from './studio-native.mjs';
import { officialStudioAsset, resolveStudioRelease, supportsOfficialStudio } from './studio-upstream.mjs';

const CHECK_INTERVAL = 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
const watchers = new Map();
const running = new Map();
const gatePrefix = '.automatic-update.';
const usePrefix = '.studio-use.';
let ownStart;

function record() {
  ownStart ??= studioProcessStarted(process.pid);
  return { pid: process.pid, started: ownStart, token: crypto.randomUUID() };
}

function live(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return true;
  try { process.kill(record.pid, 0); } catch (err) { return err.code !== 'ESRCH'; }
  if (!record.started) return true;
  const start = record.pid === process.pid ? ownStart : studioProcessStarted(record.pid);
  return !start || record.started === start;
}

function occupied(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  let owner;
  try { owner = JSON.parse(text); } catch { return true; }
  if (live(owner)) return true;
  try {
    if (fs.readFileSync(file, 'utf8') === text) fs.rmSync(file, { force: true });
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return false;
}

function hasMaintenance(dataDir, except) {
  return fs.readdirSync(dataDir).some(name => name.startsWith(gatePrefix) && name.endsWith('.lock') &&
    name !== except && occupied(path.join(dataDir, name)));
}

function releaseRecord(file, owner) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.rmSync(file, { force: true });
  } catch {}
}

// File leases also coordinate separate plugin hosts. Creating a lease and rechecking
// the gate prevents an update from passing its idle check while a request starts.
export async function acquireStudioUse(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const owner = record();
  const file = path.join(dataDir, `${usePrefix}${owner.pid}.${owner.token}.json`);
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (!hasMaintenance(dataDir)) {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      try {
        if (!hasMaintenance(dataDir)) return () => releaseRecord(file, owner);
      } catch (err) { releaseRecord(file, owner); throw err; }
      releaseRecord(file, owner);
    }
    if (Date.now() >= deadline) throw new Error('AI Studio is finishing an automatic update. Please retry shortly.');
    await sleep(50, undefined, { signal: options.signal });
  }
}

function hasUses(dataDir) {
  return fs.readdirSync(dataDir).some(name => name.startsWith(usePrefix) && occupied(path.join(dataDir, name)));
}

function beginMaintenance(dataDir) {
  if (hasMaintenance(dataDir)) return null;
  const owner = record();
  // Every owner has a unique filename: concurrent stale-record cleanup cannot
  // unlink a successor's live gate after a check/delete race.
  const name = `${gatePrefix}${owner.token}.lock`;
  const gate = path.join(dataDir, name);
  fs.writeFileSync(gate, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const release = () => releaseRecord(gate, owner);
  try {
    if (hasMaintenance(dataDir, name) || hasUses(dataDir)) { release(); return null; }
    return release;
  } catch (err) { release(); throw err; }
}

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || '');
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') } : null;
}

// Releases are stable; an equal-core prerelease can advance to its stable release.
// Unknown/development versions and a newer installed version are left alone.
export function newerStudioRelease(latest, installed) {
  const next = parseVersion(latest), current = parseVersion(installed);
  if (!next || !current || next.pre) return false;
  for (let i = 0; i < 3; i++) {
    if (next.core[i] !== current.core[i]) return next.core[i] > current.core[i];
  }
  return !!current.pre;
}

async function idleStatus(local, options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const health = await checkStudioHealth(local, fetchFn);
  if (health.state !== 'up') return null;
  const s = health.status;
  // Missing capabilities are uncertainty, never permission to restart a service.
  // Older backends expose ready/download and perform preparation inside their
  // account tasks. Newer backends also report independent background preparation.
  const browser = s.camoufox;
  if (s.active_requests !== 0 || typeof browser?.ready !== 'boolean' ||
      (browser.preparing !== undefined && browser.preparing !== false) || (!browser.ready && browser.download) ||
      !['RUNNING', 'STOPPED'].includes(s.state) || (s.accounts.busy ?? 0) > 0) return null;
  const tasks = await studioAdmin(local, 'GET', '/api/accounts/tasks', null, { fetchFn, timeoutMs: 3000 });
  if (!Array.isArray(tasks?.tasks) || tasks.tasks.some(t => !['done', 'failed', 'cancelled', 'canceled'].includes(t?.state))) return null;
  const update = await studioAdmin(local, 'GET', '/api/update', null, { fetchFn, timeoutMs: 5000 });
  if (typeof update?.updating !== 'boolean' || update.updating) return null;
  return s;
}

function stateFile(dataDir) { return path.join(dataDir, 'automatic-update.json'); }
function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')); } catch { return {}; }
}
function saveState(dataDir, state) {
  const file = stateFile(dataDir), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

// Check and stage without stopping the current service. The setup lock prevents an
// uninstall or explicit installation racing the download. Ordinary traffic keeps
// using the running service; the short maintenance gate protects only replacement.
export function updateStudioAutomatically(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  if (running.has(dataDir)) return running.get(dataDir);
  const job = checkAndUpdate({ ...options, dataDir }).finally(() => running.delete(dataDir));
  running.set(dataDir, job);
  return job;
}

async function checkAndUpdate(options) {
  const { dataDir } = options;
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  if (!supportsOfficialStudio(platform, arch) || !studioAutoUpdates(dataDir)) return { state: 'disabled' };
  return withStudioUpdate(options, async ({ local, replace }) => {
    let state = readState(dataDir);
    const now = Date.now();
    if (!options.force && state.retryAt > now) return { state: 'waiting' };
    if (!options.force && !state.pending && now - (state.checkedAt || 0) < CHECK_INTERVAL) return { state: 'current', version: state.version };
    if (hasUses(dataDir)) return { state: 'busy' };
    let stage, releaseGate;
    try {
      const initial = await idleStatus(local, options);
      if (!initial) return { state: 'busy' };
      let release = state.pending;
      if (!release || now - (state.checkedAt || 0) >= CHECK_INTERVAL || options.force) {
        release = await resolveStudioRelease({ ...options, version: undefined, proxy: downloadProxy(dataDir, options.proxy) });
        state = { ...state, checkedAt: now, pending: release, retryAt: 0 };
        saveState(dataDir, state);
      }
      release = officialStudioAsset({ tag_name: release.version, assets: [{ name: release.asset, browser_download_url: release.url, digest: `sha256:${release.sha256}` }] }, { platform, arch });
      if (!newerStudioRelease(release.version, initial.version)) {
        saveState(dataDir, { ...state, version: initial.version, pending: null });
        return { state: 'current', version: initial.version };
      }
      if (state.failedArchive === release.sha256) return { state: 'blocked', version: initial.version };
      const originalHash = computeFileHash(local.binaryPath);
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-update-'));
      const archive = path.join(dataDir, release.asset);
      const cached = fs.existsSync(archive) && computeFileHash(archive) === release.sha256;
      await installStudio({
        ...options, dataDir: stage, version: release.version,
        archivePath: cached ? archive : undefined, proxy: downloadProxy(dataDir, options.proxy)
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'install-manifest.json'), 'utf8'));
      if (manifest.archiveSha256 !== release.sha256) throw new Error('Official release digest changed while preparing the update');
      if (!cached) fs.copyFileSync(path.join(stage, manifest.asset), archive);
      releaseGate = beginMaintenance(dataDir);
      if (!releaseGate) return { state: 'busy', pending: release.version };
      const final = await idleStatus(local, options);
      if (!final || !studioAutoUpdates(dataDir)) return { state: 'busy', pending: release.version };
      if (computeFileHash(local.binaryPath) !== originalHash) return { state: 'changed' };
      if (!newerStudioRelease(release.version, final.version)) return { state: 'current', version: final.version };
      try {
        await replace(stage);
      } catch (err) {
        // A release that cannot start is not repeatedly installed each idle minute.
        // Transient stop/file-access failures still use the normal retry interval.
        if (err.studioRejectedRelease) state.failedArchive = release.sha256;
        throw err;
      }
      saveState(dataDir, { checkedAt: now, updatedAt: Date.now(), version: release.version, pending: null });
      return { state: 'updated', version: release.version };
    } catch (err) {
      saveState(dataDir, { ...state, retryAt: Date.now() + RETRY_INTERVAL, error: String(err.message) });
      return { state: 'failed', error: err.message };
    } finally {
      releaseGate?.();
      if (stage) await fs.promises.rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}

// The host remains responsive and failures leave the current service usable.
// Timers never keep a short-lived CLI or plugin host alive on their own.
export function watchStudioUpdates(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  if (watchers.has(dataDir)) return;
  try { if (!localStudio({ dataDir })) return; } catch { return; }
  const tick = () => {
    try {
      if (!localStudio({ dataDir })) {
        clearInterval(watchers.get(dataDir));
        watchers.delete(dataDir);
        return;
      }
      // Keep observing policy changes so `updates auto` works without restarting
      // an already-running plugin host that previously had updates disabled.
      if (!studioAutoUpdates(dataDir)) return;
      updateStudioAutomatically({ ...options, dataDir }).catch(() => {});
    } catch {}
  };
  const timer = setInterval(tick, 60000);
  timer.unref?.();
  watchers.set(dataDir, timer);
  const first = setTimeout(tick, 1000);
  first.unref?.();
}

export function holdStudioResponse(response, release, signal) {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', abort);
    release();
  };
  const abort = () => { reader.cancel(signal.reason).catch(() => {}).finally(finish); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); finish(); }
        else controller.enqueue(next.value);
      } catch (err) { controller.error(err); finish(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

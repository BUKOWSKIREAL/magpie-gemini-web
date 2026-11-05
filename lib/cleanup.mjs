import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  studioDataDir,
  cleanStudio,
  hasStudioAssets,
  setStudioAssetHook
} from './studio-native.mjs';
import {
  getDataDir,
  cleanBackend,
  hasBackendAssets,
  setBackendAssetHook
} from './native.mjs';

export const PLUGIN_PACKAGE_NAME = 'magpie-gemini-web';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DETACHED_WORKER_PATH = fileURLToPath(new URL('./cleanup-detached.cjs', import.meta.url));

function normalizeComparePath(p, platform = process.platform) {
  let resolved = path.resolve(p);
  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
  } catch {}
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isLocalPathSpec(spec) {
  return (
    spec.startsWith('/') ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('file:') ||
    /^[a-zA-Z]:[\\/]/.test(spec)
  );
}

function resolvePathSpec(magpieDir, spec) {
  if (spec.startsWith('file:')) {
    try {
      return fileURLToPath(spec);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(spec) ? path.resolve(spec) : path.resolve(magpieDir, spec);
}

function matchesPluginSpec(magpieDir, rawSpec, pluginRoot = PLUGIN_ROOT) {
  if (typeof rawSpec !== 'string') return false;
  const spec = rawSpec.trim();
  if (!spec) return false;

  if (spec === PLUGIN_PACKAGE_NAME || spec.startsWith(`${PLUGIN_PACKAGE_NAME}@`)) {
    return true;
  }

  if (!isLocalPathSpec(spec)) {
    return /(?:^|[/:])magpie-gemini-web(?:\.git)?(?:[#@/?].*)?$/.test(spec);
  }

  const target = resolvePathSpec(magpieDir, spec);
  if (!target || !fs.existsSync(target)) return false;

  if (pluginRoot && normalizeComparePath(target) === normalizeComparePath(pluginRoot)) {
    return true;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    return pkg?.name === PLUGIN_PACKAGE_NAME;
  } catch {
    return false;
  }
}

// isPluginInMagpie checks whether magpie-gemini-web is still listed in Magpie's plugins.json
// (including when disabled with "off": true). Returns:
//   - true  when the plugin is present in plugins.json
//   - false when plugins.json is valid and the plugin has been removed from it
//   - null  when plugins.json does not exist or cannot be parsed right now
export function isPluginInMagpie(magpieDir, options = {}) {
  if (typeof magpieDir !== 'string' || !magpieDir.trim()) return null;
  const pluginsPath = path.join(magpieDir, 'plugins.json');
  let raw;
  try {
    raw = fs.readFileSync(pluginsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
    return null;
  }

  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  for (const item of parsed.plugins) {
    const spec = typeof item === 'string' ? item : item?.spec;
    if (matchesPluginSpec(magpieDir, spec, pluginRoot)) {
      return true;
    }
  }

  return false;
}

export function hasDownloadedAssets(options = {}) {
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  return hasStudioAssets(studioDir) || hasBackendAssets(webDir);
}

// cleanDownloadedAssets stops and deletes downloaded local binaries, archives, and Camoufox
// for both AI Studio and Gemini Web while preserving user accounts, databases, and configs.
export async function cleanDownloadedAssets(options = {}) {
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const [studio, web] = await Promise.all([
    cleanStudio({ dataDir: studioDir, platform, fetchFn }).catch(err => ({
      stopped: false,
      cleaned: false,
      removed: [],
      dataDir: studioDir,
      error: err.message
    })),
    cleanBackend({ dataDir: webDir, platform, fetchFn }).catch(err => ({
      stopped: false,
      cleaned: false,
      removed: [],
      dataDir: webDir,
      error: err.message
    }))
  ]);

  return { studio, web };
}

function watcherPidFilePath(magpieDir) {
  const key = crypto.createHash('sha256').update(path.resolve(magpieDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `magpie-gemini-web-cleanup-${key}.pid`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLiveWatcherPid(pidFile) {
  if (!pidFile) return null;
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (isProcessAlive(pid)) return pid;
  } catch {}
  return null;
}

export function spawnDetachedCleanup(config, spawnFn = spawn) {
  if (!fs.existsSync(DETACHED_WORKER_PATH)) return null;
  const child = spawnFn(process.execPath, [DETACHED_WORKER_PATH], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      MAGPIE_CLEANUP_CFG: JSON.stringify(config)
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.on?.('error', () => {});
  child.unref?.();
  return child;
}

export function ensureDetachedWatcher(options = {}) {
  const magpieDir = options.magpieDir;
  if (typeof magpieDir !== 'string' || !magpieDir.trim()) return null;
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const pollMs = options.pollMs ?? 2000;
  const spawnFn = options.spawnFn || spawn;

  if (!hasStudioAssets(studioDir) && !hasBackendAssets(webDir)) {
    return null;
  }

  const pidFile = options.pidFile || watcherPidFilePath(magpieDir);
  const existingPid = readLiveWatcherPid(pidFile);
  if (existingPid) {
    return { pid: existingPid, pidFile, reused: true };
  }

  const child = spawnDetachedCleanup({
    magpieDir: path.resolve(magpieDir),
    pluginRoot,
    studioDir,
    webDir,
    pidFile,
    mode: 'watch',
    pollMs
  }, spawnFn);

  if (child?.pid) {
    try {
      fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
    } catch {}
  }

  return { pid: child?.pid ?? null, pidFile, reused: false };
}

const activeRegistrations = new Map();

export function isPluginRemovedInActiveMagpie() {
  for (const reg of activeRegistrations.values()) {
    if (isPluginInMagpie(reg.magpieDir, { pluginRoot: reg.pluginRoot }) === false) {
      return true;
    }
  }
  return false;
}

// registerMagpieCleanup hooks Magpie's plugin lifecycle so removing magpie-gemini-web from
// Magpie's plugins.json automatically stops and deletes downloaded local binaries and Camoufox.
export function registerMagpieCleanup(input, options = {}) {
  const magpieDir = typeof input?.directory === 'string' ? input.directory.trim() : '';
  if (!magpieDir) return null;

  const resolvedMagpieDir = path.resolve(magpieDir);
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  if (isPluginInMagpie(resolvedMagpieDir, { pluginRoot }) !== true) {
    return null;
  }

  if (activeRegistrations.has(resolvedMagpieDir)) {
    const existing = activeRegistrations.get(resolvedMagpieDir);
    existing.ensureWatcher();
    return existing;
  }

  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const pollMs = options.pollMs ?? 2000;
  const spawnFn = options.spawnFn || spawn;
  const pidFile = options.pidFile || watcherPidFilePath(resolvedMagpieDir);

  let cleaned = false;
  let lastPid = null;
  let watcher = null;

  const ensureWatcher = () => {
    const state = isPluginInMagpie(resolvedMagpieDir, { pluginRoot });
    if (state === true) {
      cleaned = false;
    }
    if (cleaned || state === false) return null;
    const res = ensureDetachedWatcher({
      magpieDir: resolvedMagpieDir,
      pluginRoot,
      studioDir,
      webDir,
      pollMs,
      pidFile,
      spawnFn
    });
    if (res?.pid) lastPid = res.pid;
    return res;
  };

  const triggerIfRemoved = () => {
    const state = isPluginInMagpie(resolvedMagpieDir, { pluginRoot });
    if (state === true) {
      if (cleaned) {
        cleaned = false;
        ensureWatcher();
      }
      return false;
    }
    if (state !== false || cleaned) return false;
    cleaned = true;
    // Rely on the detached worker instead of running in-process cleanup so an in-flight request in
    // the still-loaded host module cannot race with cleanup or leave cleaned permanently stuck.
    if (!readLiveWatcherPid(pidFile) && (hasStudioAssets(studioDir) || hasBackendAssets(webDir))) {
      const child = spawnDetachedCleanup({
        magpieDir: resolvedMagpieDir,
        pluginRoot,
        studioDir,
        webDir,
        pidFile,
        mode: 'immediate'
      }, spawnFn);
      if (child?.pid) {
        lastPid = child.pid;
        try { fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 }); } catch {}
      }
    }
    return true;
  };

  try {
    watcher = fs.watch(resolvedMagpieDir, (_eventType, filename) => {
      if (!filename || filename === 'plugins.json') {
        triggerIfRemoved();
      }
    });
    watcher.on?.('error', () => {});
    watcher.unref?.();
  } catch {}

  const notifyAssetInstalled = () => {
    for (const reg of activeRegistrations.values()) {
      reg.ensureWatcher();
    }
  };
  setStudioAssetHook(notifyAssetInstalled);
  setBackendAssetHook(notifyAssetInstalled);
  ensureWatcher();

  const handle = {
    magpieDir: resolvedMagpieDir,
    pluginRoot,
    pidFile,
    get pid() {
      const live = readLiveWatcherPid(pidFile);
      if (live) return live;
      return isProcessAlive(lastPid) ? lastPid : undefined;
    },
    ensureWatcher,
    triggerIfRemoved,
    close() {
      try { watcher?.close(); } catch {}
      activeRegistrations.delete(resolvedMagpieDir);
    }
  };

  activeRegistrations.set(resolvedMagpieDir, handle);
  return handle;
}

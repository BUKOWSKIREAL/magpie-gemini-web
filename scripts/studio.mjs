#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  studioDataDir,
  studioAutoUpdates,
  setStudioAutoUpdate,
  localStudio,
  installStudio,
  useStudioBinary,
  useDefaultStudio,
  ensureStudio,
  studioLogin,
  prepareStudioBrowser,
  studioAccounts,
  stopStudio,
  cleanStudio,
  studioStatus,
  studioProxy,
  saveStudioProxy,
  studioCommand,
  nodeFetch,
  readStudioEnv,
  parseAccountOrder,
  parseModelAccounts
} from '../lib/studio-native.mjs';
import { proxyLine, orderAccounts } from '../lib/studio.mjs';

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function printHelp() {
  console.log(`magpie-gemini-web AI Studio management CLI

Usage:
  node scripts/studio.mjs <command> [options]

Commands:
  install [--version <tag>] [--archive <path>] Download the official CLI (latest stable by default); stop the service first
  use <executable>                            Select a custom executable; stop the old service first
  use-default                                 Select the default local directory; first start installs if missing
  updates [auto|manual]                       Show or change automatic updates for the default official backend
  start [--proxy <url>]                        Start local AIStudio2API service in the background
  status                                       Check service and accounts status
  stop                                         Stop local AIStudio2API service
  clean                                        Stop service and remove downloaded binaries & Camoufox (keeps accounts & config)
  prepare-browser                              Download Camoufox before signing in (outside Magpie’s 10-minute wait)
  login                                        Open isolated browser login for a new Google account
  relogin [<account>]                          Sign an account that needs it in again (its label or id)
  import <auth-directory>                      Import accounts from an existing auth directory (service must be stopped)

Options:
  --data-dir <path>                            Custom data directory
  --proxy <url>                                HTTP, HTTPS, or SOCKS5 proxy URL ("" clears the saved one)
  --version <tag>                              Install a specific official release and keep updates manual (install only)
  --archive <path>                             Local official archive; verify against the selected GitHub release
`);
}

function parseArgs(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--data-dir' || arg === '--proxy' || arg === '--archive' || arg === '--version') {
      const next = args[i + 1];
      // An empty --proxy clears the proxy saved for the service.
      if (next === undefined || next.startsWith('--') || (!next && arg !== '--proxy')) {
        throw new Error(`Missing required value for option: ${arg}`);
      }
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = args[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

// saveProxy saves the proxy given with --proxy as the service's own, as its admin page does,
// once the data directory is set up.
function saveProxy(dataDir, proxy) {
  if (proxy !== undefined && fs.existsSync(path.join(dataDir, 'config.json'))) saveStudioProxy(dataDir, proxy);
}

function validateStorageState(filePath) {
  let content;
  try {
    content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }

  if (!content || typeof content !== 'object' || !Array.isArray(content.cookies) || !Array.isArray(content.origins)) {
    throw new Error(`${filePath} must be an object with cookies and origins arrays`);
  }

  let hasAuthCookie = false;
  for (const c of content.cookies) {
    if (!c || typeof c !== 'object') {
      throw new Error(`Invalid cookie entry in ${filePath}`);
    }
    if (typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || typeof c.domain !== 'string' || !c.domain) {
      throw new Error(`Invalid cookie properties in ${filePath}`);
    }
    if (c.name === 'SAPISID' || c.name === '__Secure-3PAPISID') {
      if (c.value.trim().length > 0) hasAuthCookie = true;
    }
  }

  if (!hasAuthCookie) {
    throw new Error(`${filePath} does not contain valid Google auth cookies (missing SAPISID or __Secure-3PAPISID)`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags._.length === 0) {
    printHelp();
    return;
  }

  const command = flags._[0];
  if (command !== 'install' && (flags.version !== undefined || flags.archive !== undefined)) {
    throw new Error('--version and --archive apply to install only; start reuses the selected executable');
  }
  const dataDir = flags.dataDir ? path.resolve(flags.dataDir) : studioDataDir();

  switch (command) {
    case 'updates': {
      const policy = flags._[1];
      if (flags._.length > 2 || (policy !== undefined && !['auto', 'manual'].includes(policy))) {
        throw new Error('Usage: updates [auto|manual]');
      }
      if (policy !== undefined) await setStudioAutoUpdate(policy === 'auto', { dataDir });
      const local = localStudio({ dataDir });
      if (local?.backendMode === 'user') console.log('Custom executables remain user-managed.');
      else if (!fs.existsSync(path.join(dataDir, 'config.json'))) console.log('Not installed; automatic updates are enabled by default after installation.');
      else console.log(studioAutoUpdates(dataDir)
        ? 'Automatic updates enabled. While Magpie is open, it checks official stable releases and updates when requests, sign-in and browser preparation are idle.'
        : 'Automatic updates disabled. Update from the backend management page or install an official release explicitly.');
      break;
    }
    case 'use': {
      if (flags._.length !== 2) throw new Error('Usage: use <path-to-extracted-aistudio2api-executable>');
      const local = await useStudioBinary(flags._[1], { dataDir, proxy: flags.proxy });
      saveProxy(dataDir, flags.proxy);
      console.log(`User-managed AIStudio2API selected: ${local.binaryPath}`);
      console.log(`Data directory: ${dataDir}`);
      console.log('You control this executable and its updates. Plugin cleanup preserves this backend and its runtime.');
      console.log(`Start it with: ${studioCommand('start', { dataDir })}`);
      break;
    }
    case 'use-default': {
      if (flags._.length !== 1) throw new Error('Usage: use-default');
      await useDefaultStudio({ dataDir });
      console.log('Default local AIStudio2API directory selected. Your custom executable has been kept.');
      console.log(`Start it with: ${studioCommand('start', { dataDir })}`);
      break;
    }
    case 'install': {
      const status = await studioStatus({ dataDir });
      if (status.status === 'running' || status.status === 'unresponsive') {
        throw new Error('Cannot install or update AI Studio while service is running. Stop the service first.');
      }
      console.log(`Installing AIStudio2API into ${dataDir}...`);
      const local = await installStudio({
        dataDir,
        archivePath: flags.archive,
        version: flags.version,
        proxy: flags.proxy
      });
      saveProxy(dataDir, flags.proxy);
      console.log(`AIStudio2API installed successfully.`);
      console.log(`Listen origin: ${local.origin}`);
      console.log(`Data directory: ${local.dataDir}`);
      break;
    }
    case 'prepare-browser': {
      const local = await ensureStudio({ dataDir, proxy: flags.proxy, managementOnly: true });
      saveProxy(dataDir, flags.proxy);
      console.log('Preparing the login browser. This can take longer than ten minutes; the backend keeps downloading if this command is closed.');
      let last;
      await prepareStudioBrowser(local, { fetchFn: nodeFetch, onProgress: state => {
        const message = state.ready ? 'Camoufox is ready. Return to Magpie and connect your Google account.' : state.download
          ? 'Downloading Camoufox: ' + Math.floor(state.download.received / 1048576) + ' / ' + Math.floor(state.download.total / 1048576) + ' MB'
          : 'Preparing Camoufox…';
        if (message !== last) console.log(message);
        last = message;
      } });
      break;
    }
    case 'start': {
      const status = await studioStatus({ dataDir });
      if (status.status === 'running') {
        if (flags.proxy !== undefined) {
          throw new Error('Cannot update proxy while service is running. Stop the service first.');
        }
        const local = await ensureStudio({ dataDir });
        console.log(`AIStudio2API service is running.`);
        console.log(`API Base URL: ${local.baseURL}`);
        console.log(`Management URL: ${local.origin}`);
        return;
      }
      console.log(`Starting AIStudio2API service in ${dataDir}...`);
      // --proxy is saved as the service's own, as its admin page saves one, not set over it
      const local = await ensureStudio({ dataDir, savedProxy: flags.proxy });
      console.log(`AIStudio2API service is running.`);
      console.log(`API Base URL: ${local.baseURL}`);
      console.log(`Management URL: ${local.origin}`);
      break;
    }
    case 'status': {
      const status = await studioStatus({ dataDir });
      const automatic = !fs.existsSync(path.join(dataDir, 'config.json')) || studioAutoUpdates(dataDir);
      console.log(`Service status: ${status.status}`);
      console.log(`Backend: ${status.backendMode === 'user' ? 'custom executable' : 'local installation'}; updates: ${automatic ? 'automatic official stable releases while Magpie is open' : 'user-controlled'}`);
      if (status.binaryPath) console.log(`Executable: ${status.binaryPath}`);
      if (status.version) console.log(`Version: ${status.version}`);
      if (status.version?.includes('-magpie.')) console.log(automatic
        ? 'Legacy managed build: automatic updates can switch to a newer official stable release when idle. Accounts and settings are kept.'
        : 'Legacy managed build: its built-in updater is restricted. You can replace it with an official executable while stopped. Accounts and settings are kept.');
      if (status.status === 'running') {
        console.log(`State: ${status.state || 'RUNNING'}`);
        console.log(`Listen port: ${status.port}`);
        console.log(`Accounts: ready=${status.accounts?.ready ?? 0}, total=${status.accounts?.total ?? 0}`);
        const local = localStudio({ dataDir });
        console.log(`Management URL: ${local.origin} (user ${local.adminUsername}, password: adminPassword in ${path.join(dataDir, 'config.json')})`);
        try {
          console.log(`Proxy: ${proxyLine(await studioProxy(local, { standalone: true }), local)}`);
        } catch (err) {
          console.log(`Proxy: could not be read (${err.message})`);
        }
        let env = {};
        try {
          env = readStudioEnv(dataDir);
        } catch {}
        const routingStrategy = (env.ROUTING_STRATEGY || '').trim().toLowerCase();
        const accountOrder = routingStrategy === 'round-robin' ? '' : (env.ACCOUNT_ORDER || '');
        const orderList = parseAccountOrder(accountOrder);
        if (orderList.length > 0) {
          console.log(`Account order: ${orderList.join(' -> ')}`);
        }
        const bindings = parseModelAccounts(env.MODEL_ACCOUNTS || '');
        if (bindings.size > 0) {
          const parts = [];
          for (const [model, ids] of bindings) {
            parts.push(`${model}: ${ids.join(', ')}`);
          }
          console.log(`Model accounts: ${parts.join('; ')}`);
        }
        const accounts = orderAccounts(await studioAccounts({ dataDir }), accountOrder);
        if (accounts.length > 0) {
          console.log(`Enabled accounts:`);
          for (const a of accounts) {
            console.log(`  - ${a.label || a.id} (${a.state || 'active'})`);
          }
        }
      } else if (status.status === 'unresponsive') {
        console.log(`Port ${status.port} answers but not properly (${status.reason})`);
        console.log(`If the service is stuck, run: ${studioCommand('stop', { dataDir })}`);
      } else if (status.status === 'foreign') {
        console.log(`Warning: Foreign listener on port ${status.port} (${status.reason})`);
      } else {
        console.log(`Data directory: ${status.dataDir}`);
      }
      break;
    }
    case 'stop': {
      console.log(`Stopping AIStudio2API service in ${dataDir}...`);
      const res = await stopStudio({ dataDir });
      if (!res.stopped) {
        throw new Error(res.reported || 'Failed to stop AI Studio service');
      }
      console.log(`AIStudio2API service stopped.`);
      break;
    }
    case 'clean': {
      console.log(`Cleaning downloaded AI Studio assets in ${dataDir}...`);
      const res = await cleanStudio({ dataDir });
      if (res.skipped === 'user_backend') {
        console.log('User-managed AIStudio2API and its runtime were kept. Use stop to stop the service; manage its files yourself.');
      } else {
        console.log(`Cleaned AI Studio assets (preserved accounts & config): ${res.removed.length ? res.removed.join(', ') : 'nothing to remove'}`);
      }
      break;
    }
    case 'login': {
      console.log(`Preparing login...`);
      const local = await ensureStudio({ dataDir, managementOnly: true });
      console.log(`Opening isolated browser window for Google AI Studio login...`);
      const account = await studioLogin(local, null, { timeoutMs: LOGIN_TIMEOUT_MS, fetchFn: nodeFetch });
      if (!account || typeof account.id !== 'string' || !account.id || account.enabled === false) {
        throw new Error('AIStudio2API did not return an enabled account');
      }
      console.log(`Login completed successfully.`);
      console.log(`Account: ${account.label || account.id || 'new'}`);
      break;
    }
    case 'relogin': {
      const local = await ensureStudio({ dataDir, managementOnly: true });
      const expired = (await studioAccounts({ dataDir })).filter(a => a.state === 'auth_required');
      if (!expired.length) {
        console.log('No account needs to sign in again.');
        return;
      }
      const wanted = flags._[1];
      const chosen = wanted
        ? expired.find(a => a.id === wanted || a.label === wanted)
        : expired.length === 1 ? expired[0] : undefined;
      if (!chosen) {
        const names = expired.map(a => a.label || a.id).join(', ');
        throw new Error(wanted
          ? `${wanted} doesn't need to sign in again; these do: ${names}`
          : `Several accounts need to sign in again; name one: ${studioCommand('relogin <account>', { dataDir })} (${names})`);
      }
      console.log(`Opening isolated browser window to sign ${chosen.label || chosen.id} in again...`);
      const account = (await studioLogin(local, chosen.id, { timeoutMs: LOGIN_TIMEOUT_MS, fetchFn: nodeFetch })) || chosen;
      if (account.state === 'auth_required') {
        throw new Error(account.message || 'Account still requires sign-in');
      }
      console.log(`Signed in again: ${account.label || account.id} (${account.state || 'unknown'})`);
      break;
    }
    case 'import': {
      const sourceDir = flags._[1];
      if (!sourceDir) {
        throw new Error('Usage: node scripts/studio.mjs import <auth-directory>');
      }
      const resolvedSource = path.resolve(sourceDir);
      if (!fs.existsSync(resolvedSource)) {
        throw new Error(`Source auth directory not found: ${resolvedSource}`);
      }
      const srcLstat = fs.lstatSync(resolvedSource);
      if (srcLstat.isSymbolicLink() || !srcLstat.isDirectory()) {
        throw new Error(`Source auth directory must be a regular directory: ${resolvedSource}`);
      }

      const status = await studioStatus({ dataDir });
      if (status.status === 'foreign') {
        throw new Error(`Port ${status.port} is occupied by an unknown/foreign listener. Cannot import accounts.`);
      }
      if (status.status !== 'stopped' && status.status !== 'not_installed') {
        throw new Error('Service is currently running. Stop the AI Studio service before importing accounts.');
      }

      const entries = fs.readdirSync(resolvedSource);
      const accountDirs = [];
      for (const entryName of entries) {
        const fullEntry = path.join(resolvedSource, entryName);
        const lstat = fs.lstatSync(fullEntry);
        if (lstat.isSymbolicLink()) {
          throw new Error(`Symlink rejected in source directory: ${fullEntry}`);
        }
        if (!lstat.isDirectory()) continue;

        const storageState = path.join(fullEntry, 'storage-state.json');
        if (!fs.existsSync(storageState)) continue;
        const stateLstat = fs.lstatSync(storageState);
        if (stateLstat.isSymbolicLink() || !stateLstat.isFile()) {
          throw new Error(`storage-state.json must be a regular file: ${storageState}`);
        }

        validateStorageState(storageState);
        accountDirs.push(entryName);
      }

      if (accountDirs.length === 0) {
        throw new Error(`No account directories with valid storage-state.json found in ${resolvedSource}`);
      }

      const destAuthDir = path.join(dataDir, 'auth');
      fs.mkdirSync(destAuthDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(destAuthDir, 0o700);

      // Preflight ALL conflicts across all accounts before writing
      for (const dirName of accountDirs) {
        const srcAccPath = path.join(resolvedSource, dirName);
        const destAccPath = path.join(destAuthDir, dirName);

        if (fs.existsSync(destAccPath) && fs.lstatSync(destAccPath).isSymbolicLink()) {
          throw new Error(`Destination account directory is a symlink: ${destAccPath}`);
        }

        const files = fs.readdirSync(srcAccPath);
        for (const f of files) {
          const srcFile = path.join(srcAccPath, f);
          const flstat = fs.lstatSync(srcFile);
          if (flstat.isSymbolicLink() || !flstat.isFile()) {
            throw new Error(`Non-regular file or symlink in account directory rejected: ${srcFile}`);
          }

          if (fs.existsSync(destAccPath)) {
            const destFile = path.join(destAccPath, f);
            if (fs.existsSync(destFile)) {
              if (fs.lstatSync(destFile).isSymbolicLink() || !fs.lstatSync(destFile).isFile()) {
                throw new Error(`Destination file is not a regular file: ${destFile}`);
              }
              const srcBytes = fs.readFileSync(srcFile);
              const destBytes = fs.readFileSync(destFile);
              if (!srcBytes.equals(destBytes)) {
                throw new Error(`Conflict: ${f} in account ${dirName} already exists with different contents. Overwrite refused.`);
              }
            }
          }
        }
      }

      // Safe stage-and-copy
      const stageBase = path.join(dataDir, `.import.tmp.${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(stageBase, { recursive: true, mode: 0o700 });

      let importedCount = 0;
      try {
        for (const dirName of accountDirs) {
          const srcAccPath = path.join(resolvedSource, dirName);
          const destAccPath = path.join(destAuthDir, dirName);
          const stageAccPath = path.join(stageBase, dirName);
          fs.mkdirSync(stageAccPath, { recursive: true, mode: 0o700 });
          fs.chmodSync(stageAccPath, 0o700);

          const files = fs.readdirSync(srcAccPath);
          for (const f of files) {
            const srcFile = path.join(srcAccPath, f);
            const stageFile = path.join(stageAccPath, f);
            const srcBytes = fs.readFileSync(srcFile);
            fs.writeFileSync(stageFile, srcBytes, { mode: 0o600 });
            fs.chmodSync(stageFile, 0o600);
          }

          if (!fs.existsSync(destAccPath)) {
            fs.renameSync(stageAccPath, destAccPath);
            fs.chmodSync(destAccPath, 0o700);
          } else {
            // Already existed with verified identical bytes, ensure modes
            for (const f of files) {
              const destFile = path.join(destAccPath, f);
              if (!fs.existsSync(destFile)) {
                fs.copyFileSync(path.join(stageAccPath, f), destFile);
              }
              fs.chmodSync(destFile, 0o600);
            }
            fs.chmodSync(destAccPath, 0o700);
          }
          importedCount++;
          console.log(`Imported account: ${dirName}`);
        }
      } finally {
        fs.rmSync(stageBase, { recursive: true, force: true });
      }

      console.log(`Successfully imported ${importedCount} account(s) into ${destAuthDir}.`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});

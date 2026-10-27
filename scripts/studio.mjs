#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  studioDataDir,
  localStudio,
  installStudio,
  ensureStudio,
  studioAdmin,
  studioAccounts,
  stopStudio,
  studioStatus,
  studioProxy,
  saveStudioProxy,
  studioCommand,
  nodeFetch
} from '../lib/studio-native.mjs';
import { proxyLine } from '../lib/studio.mjs';

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function printHelp() {
  console.log(`magpie-gemini-web AI Studio management CLI

Usage:
  node scripts/studio.mjs <command> [options]

Commands:
  install [--archive <path>] [--proxy <url>]   Install AIStudio2API binary and configure environment
  start [--proxy <url>]                        Start local AIStudio2API service in the background
  status                                       Check service and accounts status
  stop                                         Stop local AIStudio2API service
  login                                        Open isolated browser login for a new Google account
  relogin [<account>]                          Sign an account that needs it in again (its label or id)
  import <auth-directory>                      Import accounts from an existing auth directory (service must be stopped)

Options:
  --data-dir <path>                            Custom data directory
  --proxy <url>                                HTTP, HTTPS, or SOCKS5 proxy URL ("" clears the saved one)
  --archive <path>                             Local release archive file (.tar.gz or .zip)
`);
}

function parseArgs(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--data-dir' || arg === '--proxy' || arg === '--archive') {
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
  const dataDir = flags.dataDir ? path.resolve(flags.dataDir) : studioDataDir();

  switch (command) {
    case 'install': {
      const status = await studioStatus({ dataDir });
      if (status.status === 'version_conflict') throw new Error(status.reason);
      if (status.status === 'running' || status.status === 'outdated' || status.status === 'unresponsive') {
        throw new Error('Cannot install or update AI Studio while service is running. Stop the service first.');
      }
      console.log(`Installing AIStudio2API into ${dataDir}...`);
      const local = await installStudio({
        dataDir,
        archivePath: flags.archive,
        proxy: flags.proxy
      });
      saveProxy(dataDir, flags.proxy);
      console.log(`AIStudio2API installed successfully.`);
      console.log(`Listen origin: ${local.origin}`);
      console.log(`Data directory: ${local.dataDir}`);
      break;
    }
    case 'start': {
      const status = await studioStatus({ dataDir });
      if (status.status === 'version_conflict') throw new Error(status.reason);
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
      if (status.status === 'outdated') {
        console.log(`Replacing AIStudio2API ${status.version} from an earlier install with ${status.expected}...`);
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
      console.log(`Service status: ${status.status}`);
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
        const accounts = await studioAccounts({ dataDir });
        if (accounts.length > 0) {
          console.log(`Enabled accounts:`);
          for (const a of accounts) {
            console.log(`  - ${a.label || a.id} (${a.state || 'active'})`);
          }
        }
      } else if (status.status === 'version_conflict') {
        console.log(status.reason);
      } else if (status.status === 'outdated') {
        console.log(`Running version: ${status.version} from an earlier install (this plugin uses ${status.expected})`);
        console.log(`To replace it, run: ${studioCommand('start', { dataDir })}`);
        console.log(`To stop it, run: ${studioCommand('stop', { dataDir })}`);
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
    case 'login': {
      console.log(`Preparing login...`);
      const local = await ensureStudio({ dataDir, managementOnly: true });
      console.log(`Opening isolated browser window for Google AI Studio login...`);
      const res = await studioAdmin(local, 'POST', '/api/accounts', {}, { timeoutMs: LOGIN_TIMEOUT_MS, fetchFn: nodeFetch });
      const account = res?.account || res;
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
      const res = await studioAdmin(local, 'POST', `/api/accounts/${encodeURIComponent(chosen.id)}/login`, {}, { timeoutMs: LOGIN_TIMEOUT_MS, fetchFn: nodeFetch });
      const account = res?.account || chosen;
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

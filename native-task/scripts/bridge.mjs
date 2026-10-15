#!/usr/bin/env node
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedBytes, ensurePrivateDataDir, ensureService, getDefaultDataDir, loadLocalConfig, probeHealth } from '../lib/runtime.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE_DIR = path.join(ROOT_DIR, 'bridge');
const SETUP_FLAGS = ['data-dir', 'auth-file', 'task-headers', 'tool-headers', 'task-template', 'turn-template', 'binary', 'port'];
const REQUIRED = ['auth-file', 'task-headers', 'tool-headers', 'task-template', 'turn-template'];
function safeError(message) { return Object.assign(new Error(message), { safeMessage: true }); }

function validateFlags(command, flags) {
  if (!['setup', 'start', 'status', 'stop'].includes(command)) throw safeError('Usage: bridge.mjs setup|start|status|stop [options]');
  for (const [key, value] of Object.entries(flags)) {
    if (!(command === 'setup' ? SETUP_FLAGS : ['data-dir']).includes(key) || typeof value !== 'string' || !value) {
      throw safeError('Unsupported option or missing option value.');
    }
  }
  if (command === 'setup') {
    if (REQUIRED.some(key => !flags[key])) throw safeError('Setup requires auth-file, task-headers, tool-headers, task-template and turn-template.');
    if (flags.port !== undefined && (!/^[0-9]{4,5}$/.test(flags.port) || Number(flags.port) < 1024 || Number(flags.port) > 65535)) {
      throw safeError('Port must be an integer between 1024 and 65535.');
    }
  }
}

export function parseArgs(args) {
  const [command, ...rest] = args;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--') || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(flags, flag.slice(2))) {
      throw safeError('Expected distinct --option value pairs.');
    }
    flags[flag.slice(2)] = value;
  }
  validateFlags(command, flags);
  return { command, flags };
}

export async function setup(flags, deps = {}) {
  validateFlags('setup', flags);
  const dataDir = ensurePrivateDataDir(flags['data-dir'] ?? getDefaultDataDir(), { create: true });
  if (fs.existsSync(path.join(dataDir, 'config.json'))) throw safeError('Configuration already exists. Preserve it or choose a new data directory.');
  const exec = deps.execFileSync ?? child_process.execFileSync;
  const venvDir = path.join(dataDir, '.venv');
  if (!fs.existsSync(venvDir)) exec('python3', ['-m', 'venv', venvDir], { stdio: 'pipe', timeout: 60000 });
  exec(path.join(venvDir, 'bin/pip'), ['install', '-r', path.join(ROOT_DIR, 'requirements.txt')], { stdio: 'pipe', timeout: 120000 });
  const args = ['-m', 'gemini_native_bridge', 'bootstrap', '--data-dir', dataDir];
  for (const key of [...REQUIRED, 'binary', 'port']) if (flags[key] !== undefined) args.push(`--${key}`, flags[key]);
  const output = exec(path.join(venvDir, 'bin/python'), args, {
    env: { ...process.env, PYTHONPATH: BRIDGE_DIR }, cwd: BRIDGE_DIR, stdio: 'pipe', timeout: 120000,
  });
  // Only publish the known, nonsecret bootstrap fields.
  const result = JSON.parse(output.toString());
  if (result.configured !== true) throw safeError('Bootstrap did not complete.');
  return JSON.stringify({ configured: true, port: result.port, account_label: result.account_label, instance_id: result.instance_id }) + '\n';
}

export async function main(args = process.argv.slice(2)) {
  const { command, flags } = parseArgs(args);
  const dataDir = flags['data-dir'] ?? getDefaultDataDir();
  if (command === 'setup') return process.stdout.write(await setup(flags));
  if (command === 'start') {
    const service = await ensureService({ dataDir });
    return process.stdout.write(JSON.stringify({ status: 'running', baseURL: service.baseURL, instance_id: service.instance_id, dataDir: service.dataDir }) + '\n');
  }
  const config = loadLocalConfig(dataDir);
  const baseURL = `http://127.0.0.1:${config.port}`;
  const health = await probeHealth(baseURL, config.api_key, config.instance_id);
  if (command === 'status') {
    return process.stdout.write(JSON.stringify({ status: health ? 'running' : 'stopped', port: config.port, active_tasks: health?.active_tasks, instance_id: config.instance_id }) + '\n');
  }
  if (!health) return process.stdout.write('{"status":"already_stopped"}\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseURL}/v1/native/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' },
      body: '{}', signal: controller.signal, redirect: 'error',
    });
    if (res.status !== 202) throw safeError('Local bridge rejected shutdown.');
    const result = JSON.parse((await boundedBytes(res.body, 16384, controller.signal)).toString());
    if (result.status !== 'shutting_down') throw safeError('Invalid shutdown acknowledgement.');
    process.stdout.write('{"status":"shutting_down"}\n');
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write((error.safeMessage ? error.message : 'Bridge command failed. Check configuration, private file permissions and local service availability.') + '\n');
    process.exitCode = 1;
  });
}

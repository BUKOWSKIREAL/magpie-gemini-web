import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function controlState(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'console-state.json'), 'utf8'));
    if (state.version !== 1 || typeof state.paused !== 'boolean' || (state.appStopped !== undefined && typeof state.appStopped !== 'boolean')) throw new Error('invalid state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('本地服务控制状态文件损坏，请检查 console-state.json；为防止误启动，已停止自动操作。');
  }
}

export function writeControlState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'console-state.json');
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function assertCanStart(dataDir, allowPaused = false) {
  if (!allowPaused && controlState(dataDir)?.paused) {
    throw new Error('本地 AI Studio 已暂停自动启动，请在服务控制台点击“启动服务”。');
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createForwarder, ensureService, getDefaultDataDir } from '../native-task/lib/runtime.mjs';

// The experimental Task route: on macOS, a sign-in can go to the native-task bridge (see
// native-task/), which runs Gemini.app's own Task mode, instead of the Gemini Web backend.
// The sign-in says which with metadata.mode.

export const TASK_MODE = 'task';
export const TASK_MODEL = 'gemini-task-argon';

const BRIDGE_CLI = fileURLToPath(new URL('../native-task/scripts/bridge.mjs', import.meta.url));

// taskSupported is whether this computer can run the bridge: it drives Gemini.app for macOS.
export function taskSupported(platform = process.platform) {
  return platform === 'darwin';
}

export function isTaskAuth(auth) {
  return auth?.type === 'api' && auth.metadata?.mode === TASK_MODE;
}

// startTask starts the bridge set up in dataDir. The bridge's setup needs files only a capture
// gives, so the plugin can't run it: without one, the error says how.
async function startTask(dataDir = getDefaultDataDir()) {
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) {
    throw new Error(`还没有配置本机 Task 服务（${dataDir}）。先在终端运行 node "${BRIDGE_CLI}" setup，需要的文件见 native-task/README.md`);
  }
  return ensureService({ dataDir });
}

// taskMethod is the Magpie sign-in method for the bridge.
export const taskMethod = {
  type: 'oauth',
  label: 'macOS 原生 Task（实验性，需先完成本机 setup）',
  async authorize() {
    const service = await startTask();
    return {
      url: '',
      method: 'auto',
      instructions: '',
      callback: async () => ({
        type: 'success',
        key: service.apiKey,
        accountId: `native:${service.instance_id}`,
        metadata: { mode: TASK_MODE, baseURL: `${service.baseURL}/v1`, dataDir: service.dataDir }
      })
    };
  }
};

// taskLoader is the auth loader for a Task sign-in: requests go to the bridge, starting it when
// it isn't running.
export async function taskLoader(auth) {
  const service = await startTask(auth.metadata?.dataDir);
  if (auth.key !== service.apiKey) {
    throw Object.assign(new Error('本机 Task 服务的密钥变了，请重新登录'), { signIn: 'expired' });
  }
  return { apiKey: auth.key, baseURL: `${service.baseURL}/v1`, fetch: createForwarder(service) };
}

// taskModels is the one model the bridge serves, in the shape listModels gives.
export function taskModels(auth, providerID) {
  return {
    [TASK_MODEL]: {
      id: TASK_MODEL,
      providerID,
      name: 'Argon Task',
      api: { id: TASK_MODEL, url: auth.metadata?.baseURL, npm: '@ai-sdk/openai-compatible' },
      limit: { context: 65536, output: 8192 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, image: false },
        output: { text: true }
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      options: {},
      headers: {},
      variants: {},
      status: 'active'
    }
  };
}

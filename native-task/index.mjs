import { createForwarder, ensureService } from './lib/runtime.mjs';
const ID = 'gemini-native-task';
const MODEL = 'gemini-task-argon';
function fail(message, signIn = 'kept') {
  return Object.assign(new Error(message), { signIn });
}
export default {
  id: ID,
  server: async (_input, options = {}) => ({
    config(config) {
      config.provider ??= {};
      const p = (config.provider[ID] ??= {});
      p.npm ??= '@ai-sdk/openai-compatible';
      p.name ??= 'Gemini Native Task';
      p.models ??= {};
      p.models[MODEL] ??= {
        name: 'Argon Task', tool_call: true, reasoning: false, attachment: false,
        temperature: false, modalities: { input: ['text'], output: ['text'] },
        limit: { context: 65536, output: 8192 },
      };
    },
    provider: {
      id: ID,
      models(given) {
        const m = given?.models?.[MODEL] ?? {};
        return { [MODEL]: {
          ...m, id: MODEL, providerID: given?.id ?? ID, name: m.name ?? 'Argon Task',
          api: { id: MODEL, npm: '@ai-sdk/openai-compatible', ...(m.api ?? {}) },
          limit: { context: 65536, output: 8192, ...(m.limit ?? {}) },
          capabilities: {
            ...(m.capabilities ?? {}), temperature: false, reasoning: false, attachment: false,
            toolcall: true, input: { text: true, image: false, audio: false, video: false, pdf: false },
            output: { text: true, image: false, audio: false, video: false, pdf: false },
          },
        } };
      },
    },
    auth: {
      provider: ID, maxConcurrency: 1,
      methods: [{
        type: 'oauth', label: '连接本机 Task 服务',
        async authorize() {
          const service = await ensureService(options);
          return {
            url: '', method: 'auto', instructions: '',
            callback: async () => ({
              type: 'success', key: service.apiKey, accountId: `native:${service.instance_id}`,
              metadata: { dataDir: service.dataDir, baseURL: `${service.baseURL}/v1` },
            }),
          };
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key)
          throw fail('Connect the local Native Task service first.');
        const service = await ensureService({
          dataDir: auth.metadata?.dataDir ?? options.dataDir,
          startupTimeoutMs: options.startupTimeoutMs,
        });
        if (auth.key !== service.apiKey)
          throw fail('The saved local bridge key no longer matches this service. Connect it again.', 'expired');
        return { baseURL: `${service.baseURL}/v1`, apiKey: auth.key, fetch: createForwarder(service) };
      },
    },
    async 'chat.headers'(input, output) {
      // The host's provider info retains the originating provider identity.
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return;
      if (typeof input.sessionID === 'string' && input.sessionID) {
        output.headers ??= {};
        output.headers['X-Gemini-Session'] = input.sessionID;
      }
      // Missing stable IDs are rejected by the daemon, never invented here.
    },
  }),
};

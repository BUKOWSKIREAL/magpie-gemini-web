import { normalizeBaseURL, settings, credentials, listModels, forward } from './lib/backend.mjs';

const ID = 'gemini-web';

export const GeminiWebPlugin = async (_input, options = {}) => {
  const opts = settings(options);
  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[ID] ??= { name: 'Gemini Web', npm: '@ai-sdk/openai-compatible', api: opts.baseURL, models: {} };
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [{
        type: 'api',
        label: 'Gemini Web backend API key',
        placeholder: 'Backend API key (not a Google cookie)',
        prompts: [{
          type: 'text',
          key: 'baseURL',
          message: 'Backend OpenAI base URL (blank: plugin default)',
          placeholder: opts.baseURL,
          validate: value => {
            try {
              normalizeBaseURL(value || opts.baseURL);
            } catch (e) {
              return e.message;
            }
          }
        }],
        // Magpie stores raw prompt inputs as metadata unless authorize returns its own;
        // write the resolved URL so a blank answer doesn't persist as baseURL: "".
        authorize: async inputs => ({
          type: 'success',
          metadata: { baseURL: normalizeBaseURL(inputs?.baseURL || opts.baseURL) }
        })
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return {};
        const c = credentials(auth, opts);
        return {
          apiKey: c.key,
          baseURL: c.baseURL,
          fetch: (input, init) => forward(input, init, getAuth, opts)
        };
      }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        return listModels(credentials(auth, opts), opts);
      }
    }
  };
};

export default GeminiWebPlugin;

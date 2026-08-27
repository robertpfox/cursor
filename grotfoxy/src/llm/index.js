import { anthropicAdapter } from './anthropic.js';
import { ollamaAdapter } from './ollama.js';
import { openaiAdapter } from './openai.js';
import { LlmError } from './http.js';
import { estimateCost } from './pricing.js';

const ADAPTERS = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  ollama: ollamaAdapter,
};

/**
 * Ready-made endpoints so setting up a provider is picking a name, not reading
 * three sets of API docs. `free: true` means the preset can run without any
 * paid account at all.
 */
export const PROVIDER_PRESETS = [
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    needsKey: false,
    free: true,
    defaultModel: 'qwen2.5:7b',
    hint: 'Runs models on this machine. No account, no key, no per-token cost.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local, free)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    free: true,
    defaultModel: 'local-model',
    hint: 'Point at LM Studio\u2019s OpenAI-compatible server.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (local, free)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    needsKey: false,
    free: true,
    defaultModel: 'local-model',
    hint: 'Any llama.cpp / vLLM OpenAI-compatible endpoint.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    defaultModel: 'gpt-4.1-mini',
    hint: 'Pay-as-you-go with your own key. No GrotFoxy subscription involved.',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    defaultModel: 'grok-4-fast',
    hint: 'Grok models over the plain API instead of a bundled seat.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    defaultModel: 'openai/gpt-4.1-mini',
    hint: 'One key, hundreds of models, including free-tier ones.',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai',
    baseUrl: '',
    needsKey: false,
    defaultModel: '',
  },
];

export function getAdapter(kind) {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new LlmError(`Unknown provider kind: ${kind}`, { retryable: false });
  return adapter;
}

/**
 * Single entry point the runtime uses. `provider` is `{ kind, baseUrl, apiKey }`
 * with the key already decrypted.
 */
export async function chat({ provider, model, messages, tools, temperature = 0.2, signal }) {
  const adapter = getAdapter(provider.kind);
  const started = Date.now();
  const response = await adapter.chat({ provider, model, messages, tools, temperature, signal });
  return {
    ...response,
    latencyMs: Date.now() - started,
    costUsd: estimateCost({
      model,
      kind: provider.kind,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    }),
  };
}

export async function listModels({ provider, signal }) {
  return getAdapter(provider.kind).listModels({ provider, signal });
}

export { LlmError, estimateCost };

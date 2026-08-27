import { requestJson } from './http.js';
import { safeParseArguments } from './openai.js';

/**
 * Native Ollama chat API. This is the zero-cost path: models run on the same
 * machine that hosts GrotFoxy, so a fully offline teammate costs nothing per
 * run and nothing per month.
 */
export const ollamaAdapter = {
  kind: 'ollama',

  async chat({ provider, model, messages, tools, temperature, signal }) {
    const base = (provider.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');

    const wire = messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', content: String(message.content ?? '') };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: String(message.content ?? ''),
          tool_calls: message.toolCalls.map((call) => ({
            function: { name: call.name, arguments: call.arguments ?? {} },
          })),
        };
      }
      return { role: message.role, content: String(message.content ?? '') };
    });

    const data = await requestJson(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: wire,
        stream: false,
        options: { temperature },
        ...(tools?.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters ?? { type: 'object', properties: {} },
                },
              })),
            }
          : {}),
      }),
      signal,
    });

    // Ollama omits tool-call ids; the runtime needs stable ones to pair results.
    const toolCalls = (data?.message?.tool_calls ?? [])
      .filter((call) => call?.function?.name)
      .map((call, index) => ({
        id: `ollama_call_${index}_${Date.now().toString(36)}`,
        name: call.function.name,
        arguments: safeParseArguments(call.function.arguments),
      }));

    return {
      message: {
        role: 'assistant',
        content: data?.message?.content ?? '',
        toolCalls,
      },
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: data?.prompt_eval_count ?? 0,
        outputTokens: data?.eval_count ?? 0,
      },
    };
  },

  async listModels({ provider, signal }) {
    const base = (provider.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const data = await requestJson(`${base}/api/tags`, { method: 'GET', signal });
    return (data?.models ?? []).map((entry) => entry.name).filter(Boolean).sort();
  },
};

export default ollamaAdapter;

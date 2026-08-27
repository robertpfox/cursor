import { LlmError, requestJson } from './http.js';

/**
 * OpenAI-compatible chat completions. The same wire format is spoken by OpenAI,
 * xAI (Grok), OpenRouter, Groq, Together, DeepSeek, LM Studio, llama.cpp's
 * server and vLLM, so one adapter covers both the paid and the free-and-local
 * ends of the spectrum.
 */
export const openaiAdapter = {
  kind: 'openai',

  toWireMessages(messages) {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: String(message.content ?? ''),
        };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        };
      }
      return { role: message.role, content: String(message.content ?? '') };
    });
  },

  toWireTools(tools) {
    if (!tools?.length) return undefined;
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }));
  },

  async chat({ provider, model, messages, tools, temperature, signal }) {
    const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = {
      model,
      messages: this.toWireMessages(messages),
      tools: this.toWireTools(tools),
      temperature,
    };
    if (body.tools) body.tool_choice = 'auto';

    const data = await requestJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    const choice = data?.choices?.[0];
    if (!choice) throw new LlmError('Model returned no choices', { retryable: false, data });

    const toolCalls = (choice.message?.tool_calls ?? [])
      .filter((call) => call?.function?.name)
      .map((call, index) => ({
        id: call.id || `call_${index}`,
        name: call.function.name,
        arguments: safeParseArguments(call.function.arguments),
      }));

    return {
      message: {
        role: 'assistant',
        content: choice.message?.content ?? '',
        toolCalls,
      },
      finishReason: choice.finish_reason ?? 'stop',
      usage: {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
      },
    };
  },

  async listModels({ provider, signal }) {
    const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const data = await requestJson(`${base}/models`, {
      method: 'GET',
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      signal,
    });
    return (data?.data ?? []).map((entry) => entry.id).filter(Boolean).sort();
  },
};

export function safeParseArguments(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Smaller models occasionally emit almost-JSON. Salvage the outermost
    // object rather than failing the whole step.
    const start = String(raw).indexOf('{');
    const end = String(raw).lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(String(raw).slice(start, end + 1));
      } catch {
        /* fall through to the raw passthrough below */
      }
    }
    return { _raw: String(raw) };
  }
}

export default openaiAdapter;

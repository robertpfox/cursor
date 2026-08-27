import { LlmError, requestJson } from './http.js';

/** Anthropic Messages API. System prompt is a top-level field, not a message. */
export const anthropicAdapter = {
  kind: 'anthropic',

  toWire(messages) {
    const systemParts = [];
    const wire = [];

    for (const message of messages) {
      if (message.role === 'system') {
        systemParts.push(String(message.content ?? ''));
        continue;
      }
      if (message.role === 'tool') {
        // Consecutive tool results must be merged into one user turn.
        const block = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: String(message.content ?? ''),
          ...(message.isError ? { is_error: true } : {}),
        };
        const last = wire.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content) && last._toolResults) {
          last.content.push(block);
        } else {
          wire.push({ role: 'user', content: [block], _toolResults: true });
        }
        continue;
      }
      if (message.role === 'assistant') {
        const content = [];
        if (message.content) content.push({ type: 'text', text: String(message.content) });
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments ?? {},
          });
        }
        if (content.length) wire.push({ role: 'assistant', content });
        continue;
      }
      wire.push({ role: 'user', content: String(message.content ?? '') });
    }

    for (const entry of wire) delete entry._toolResults;
    return { system: systemParts.join('\n\n'), messages: wire };
  },

  async chat({ provider, model, messages, tools, temperature, maxTokens = 4096, signal }) {
    const base = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const { system, messages: wireMessages } = this.toWire(messages);

    const data = await requestJson(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: wireMessages,
        ...(tools?.length
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters ?? { type: 'object', properties: {} },
              })),
            }
          : {}),
      }),
      signal,
    });

    if (!Array.isArray(data?.content)) {
      throw new LlmError('Anthropic returned an unexpected body', { retryable: false, data });
    }

    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = data.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));

    return {
      message: { role: 'assistant', content: text, toolCalls },
      finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : (data.stop_reason ?? 'stop'),
      usage: {
        inputTokens: data?.usage?.input_tokens ?? 0,
        outputTokens: data?.usage?.output_tokens ?? 0,
      },
    };
  },

  async listModels({ provider, signal }) {
    const base = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const data = await requestJson(`${base}/v1/models`, {
      method: 'GET',
      headers: { 'x-api-key': provider.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      signal,
    });
    return (data?.data ?? []).map((entry) => entry.id).filter(Boolean).sort();
  },
};

export default anthropicAdapter;

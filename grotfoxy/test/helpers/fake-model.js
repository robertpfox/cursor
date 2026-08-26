import http from 'node:http';

/**
 * A scripted OpenAI-compatible endpoint. Each entry in `script` is returned for
 * the corresponding request, so a test can drive an agent through an exact
 * sequence of tool calls and a final answer using the real provider code path.
 *
 * Entry shape: `{ content?: string, toolCalls?: [{ name, arguments }] }`
 */
export async function startFakeModel(script = []) {
  const requests = [];
  let index = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url.startsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }, { id: 'fake-model-2' }] }));
        return;
      }

      const parsed = body ? JSON.parse(body) : {};
      requests.push(parsed);

      const step = script[index] ?? { content: 'Nothing further to do.' };
      index += 1;

      const message = { role: 'assistant', content: step.content ?? null };
      if (step.toolCalls?.length) {
        message.tool_calls = step.toolCalls.map((call, i) => ({
          id: call.id ?? `call_${index}_${i}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    callCount: () => index,
    close: () =>
      new Promise((resolve) => {
        // `fetch` holds keep-alive sockets open, so a plain close() never
        // resolves. Drop them explicitly.
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** Poll until a run leaves the states that mean "still working". */
export async function waitForRun(getRun, runId, { until, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const isDone =
    until ??
    ((record) =>
      ['succeeded', 'failed', 'cancelled', 'incomplete', 'awaiting_approval', 'awaiting_input'].includes(
        record.status,
      ));

  while (Date.now() < deadline) {
    const record = getRun(runId);
    if (record && isDone(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not settle within ${timeoutMs}ms (status: ${getRun(runId)?.status})`);
}

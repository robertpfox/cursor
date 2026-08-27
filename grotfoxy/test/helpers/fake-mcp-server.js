#!/usr/bin/env node
/**
 * A minimal but real MCP server over stdio, used to prove the connector path
 * end to end: initialize, tools/list, tools/call.
 */
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back whatever text you send.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`);
}

// Servers commonly print a banner; the client must tolerate it.
process.stderr.write('fake-mcp-server ready\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};
    if (name === 'echo') {
      reply(id, { content: [{ type: 'text', text: `echo: ${args.text}` }] });
      return;
    }
    if (name === 'add') {
      reply(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
      return;
    }
    if (name === 'always_fails') {
      reply(id, { content: [{ type: 'text', text: 'this tool is broken' }], isError: true });
      return;
    }
    replyError(id, `unknown tool: ${name}`);
    return;
  }
  replyError(id, `unknown method: ${method}`);
});

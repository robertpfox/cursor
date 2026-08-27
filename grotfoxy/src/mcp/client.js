import { spawn } from 'node:child_process';
import log from '../core/logger.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'grotfoxy', version: '1.0.0' };

class Pending {
  constructor() {
    this.map = new Map();
  }

  create(id, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        onTimeout?.();
        reject(new Error(`MCP request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.map.set(id, { resolve, reject, timer });
    });
  }

  settle(id, error, result) {
    const entry = this.map.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.map.delete(id);
    if (error) entry.reject(new Error(error.message || JSON.stringify(error)));
    else entry.resolve(result);
  }

  rejectAll(reason) {
    for (const [, entry] of this.map) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.map.clear();
  }
}

/** JSON-RPC over a child process's stdin/stdout, newline delimited. */
class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.spec = { command, args, env, cwd };
    this.pending = new Pending();
    this.nextId = 1;
    this.buffer = '';
    this.child = null;
    this.stderr = '';
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd || undefined,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.child.on('exit', (code) => {
      this.pending.rejectAll(
        `MCP server exited with code ${code}${this.stderr ? `: ${this.stderr.slice(-500)}` : ''}`,
      );
      this.child = null;
    });
    this.child.on('error', (error) => {
      this.pending.rejectAll(`MCP server failed to start: ${error.message}`);
      this.child = null;
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Servers sometimes print banner text on stdout; skip it.
      }
      if (message.id !== undefined && message.id !== null) {
        this.pending.settle(message.id, message.error, message.result);
      }
    }
  }

  async request(method, params, timeoutMs) {
    await this.start();
    const id = this.nextId++;
    const promise = this.pending.create(id, timeoutMs);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.pending.rejectAll('MCP connection closed');
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

/** Streamable-HTTP transport. Handles both plain JSON and SSE-framed replies. */
class HttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.nextId = 1;
  }

  async start() {
    /* stateless: nothing to boot */
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const text = await response.text();
      const message = parseRpcBody(text, id);
      if (!message) throw new Error('MCP server returned no JSON-RPC response');
      if (message.error) throw new Error(message.error.message || JSON.stringify(message.error));
      return message.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method, params) {
    await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      // Notifications are fire-and-forget by definition.
    });
  }

  close() {
    this.sessionId = null;
  }
}

export function parseRpcBody(text, expectedId) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // SSE framing: pick the data payload carrying our request id.
  let fallback = null;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.id === expectedId) return parsed;
      fallback ??= parsed;
    } catch {
      /* skip malformed frames */
    }
  }
  return fallback;
}

/**
 * One connection to one MCP server. Connections are cached by the registry and
 * reused across runs, because spawning a Node/Python MCP server per tool call
 * would dominate the latency of a step.
 */
export class McpClient {
  constructor(spec) {
    this.spec = spec;
    this.transport =
      spec.transport === 'http' ? new HttpTransport(spec) : new StdioTransport(spec);
    this.initialized = false;
    this.tools = [];
  }

  async initialize({ timeoutMs = 30_000 } = {}) {
    if (this.initialized) return this.tools;
    await this.transport.start();
    await this.transport.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: CLIENT_INFO },
      timeoutMs,
    );
    await this.transport.notify('notifications/initialized', {});
    this.initialized = true;
    this.tools = await this.listTools({ timeoutMs });
    return this.tools;
  }

  async listTools({ timeoutMs = 30_000 } = {}) {
    const result = await this.transport.request('tools/list', {}, timeoutMs);
    return (result?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name, args, { timeoutMs = 120_000 } = {}) {
    if (!this.initialized) await this.initialize();
    const result = await this.transport.request(
      'tools/call',
      { name, arguments: args ?? {} },
      timeoutMs,
    );
    const text = (result?.content ?? [])
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'resource') return block.resource?.text ?? JSON.stringify(block.resource);
        return `[${block.type}]`;
      })
      .join('\n');
    if (result?.isError) throw new Error(text || 'MCP tool reported an error');
    return text || JSON.stringify(result ?? {});
  }

  close() {
    try {
      this.transport.close();
    } catch (error) {
      log.debug(`error closing MCP client ${this.spec.name}: ${error.message}`);
    }
    this.initialized = false;
  }
}

export default McpClient;

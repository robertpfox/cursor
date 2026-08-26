import fileTools from './files.js';
import shellTools from './shell.js';
import webTools from './web.js';
import builtinTools from './builtin.js';
import { callConnectorTool, connect, getConnector } from '../services/connectors.js';
import log from '../core/logger.js';

export const BUILTIN_TOOLS = [...builtinTools, ...fileTools, ...webTools, ...shellTools];

export const TOOL_GROUPS = [
  { id: 'core', label: 'Core', description: 'Time, questions and notifications.' },
  { id: 'memory', label: 'Memory', description: 'Remember facts between runs.' },
  { id: 'notify', label: 'Notifications', description: 'Ping you on your phone or desktop.' },
  { id: 'files', label: 'Files', description: 'Read and write inside the bot workspace.' },
  { id: 'web', label: 'Web', description: 'Search, read pages and call HTTP APIs.' },
  { id: 'shell', label: 'Shell', description: 'Run commands on the host machine.' },
];

export function toolCatalog() {
  return BUILTIN_TOOLS.map((tool) => ({
    name: tool.name,
    group: tool.group,
    sensitivity: tool.sensitivity,
    description: tool.description,
  }));
}

export function findBuiltinTool(name) {
  return BUILTIN_TOOLS.find((tool) => tool.name === name);
}

/** Model function names are restricted to `[a-zA-Z0-9_-]{1,64}`. */
export function mcpToolName(connectorName, toolName) {
  const raw = `mcp_${connectorName}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (raw.length <= 64) return raw;
  return `${raw.slice(0, 55)}_${hash(raw)}`;
}

function hash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 8);
}

/**
 * Assembles the exact tool list one bot is allowed to use: its enabled built-ins
 * plus every tool exposed by its enabled connectors. Connector failures are
 * degraded rather than fatal — a bot with a broken Slack server should still be
 * able to do the rest of its job.
 */
export async function buildToolset(bot) {
  const enabled = new Set(bot.tools ?? []);
  const tools = [];
  const handlers = new Map();

  for (const tool of BUILTIN_TOOLS) {
    if (!enabled.has(tool.name)) continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    });
    handlers.set(tool.name, {
      kind: 'builtin',
      sensitivity: tool.sensitivity,
      execute: (args, ctx) => tool.execute(args, ctx),
    });
  }

  const connectorIssues = [];
  for (const connectorId of bot.connectors ?? []) {
    const connector = getConnector(connectorId);
    if (!connector || !connector.enabled) continue;
    let client;
    try {
      client = await connect(connectorId);
    } catch (error) {
      log.warn(`connector "${connector.name}" unavailable: ${error.message}`);
      connectorIssues.push({ name: connector.label || connector.name, error: error.message });
      continue;
    }
    for (const tool of client.tools) {
      const name = mcpToolName(connector.name, tool.name);
      if (handlers.has(name)) continue;
      tools.push({
        name,
        description: `[${connector.label || connector.name}] ${tool.description}`.slice(0, 1024),
        parameters: normalizeSchema(tool.inputSchema),
      });
      handlers.set(name, {
        kind: 'mcp',
        sensitivity: 'sensitive',
        connectorId,
        connectorName: connector.label || connector.name,
        remoteName: tool.name,
        execute: async (args) => ({
          output: await callConnectorTool(connectorId, tool.name, args),
        }),
      });
    }
  }

  return { tools, handlers, connectorIssues };
}

/** Some MCP servers omit `type` or `properties`; models reject those schemas. */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return {
    type: schema.type ?? 'object',
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) && schema.required.length
      ? { required: schema.required }
      : {}),
  };
}

export const DEFAULT_TOOLS = [
  'get_current_time',
  'ask_user',
  'notify_user',
  'remember',
  'recall',
  'web_search',
  'fetch_page',
  'list_files',
  'read_file',
  'write_file',
];

import fs from 'node:fs';
import { all, get, now, parseJson, run } from '../db/index.js';
import { decryptSecret, encryptSecret, newId } from '../core/crypto.js';
import McpClient from '../mcp/client.js';
import log from '../core/logger.js';

const clients = new Map();

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    label: row.label || row.name,
    transport: row.transport,
    command: row.command,
    args: parseJson(row.args, []),
    env: parseJson(row.env, {}),
    cwd: row.cwd,
    url: row.url,
    enabled: Boolean(row.enabled),
    lastStatus: row.last_status,
    lastError: row.last_error,
    tools: parseJson(row.tool_cache, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConnectors() {
  return all('SELECT * FROM connectors ORDER BY name').map(toPublic);
}

export function getConnector(id) {
  return toPublic(get('SELECT * FROM connectors WHERE id = ?', id));
}

export function getConnectorByName(name) {
  return toPublic(get('SELECT * FROM connectors WHERE name = ?', name));
}

/** Connector names become part of a tool name, so keep them model-friendly. */
export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'connector';
}

export function createConnector(input) {
  const id = newId('con');
  const timestamp = now();
  let name = normalizeName(input.name);
  if (getConnectorByName(name)) name = `${name}-${id.slice(-4)}`;
  run(
    `INSERT INTO connectors (id, name, label, transport, command, args, env, cwd, url, headers_enc, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    input.label?.trim() || input.name || name,
    input.transport === 'http' ? 'http' : 'stdio',
    input.command?.trim() || '',
    JSON.stringify(input.args ?? []),
    JSON.stringify(input.env ?? {}),
    input.cwd?.trim() || '',
    input.url?.trim() || '',
    input.headers ? encryptSecret(JSON.stringify(input.headers)) : '',
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return getConnector(id);
}

export function updateConnector(id, input) {
  const existing = get('SELECT * FROM connectors WHERE id = ?', id);
  if (!existing) return null;
  disconnect(id);
  run(
    `UPDATE connectors SET label = ?, transport = ?, command = ?, args = ?, env = ?, cwd = ?, url = ?, headers_enc = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    input.label?.trim() ?? existing.label,
    input.transport ?? existing.transport,
    input.command ?? existing.command,
    JSON.stringify(input.args ?? parseJson(existing.args, [])),
    JSON.stringify(input.env ?? parseJson(existing.env, {})),
    input.cwd ?? existing.cwd,
    input.url ?? existing.url,
    input.headers ? encryptSecret(JSON.stringify(input.headers)) : existing.headers_enc,
    input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
    now(),
    id,
  );
  return getConnector(id);
}

export function deleteConnector(id) {
  disconnect(id);
  run('DELETE FROM connectors WHERE id = ?', id);
}

function specFor(row) {
  const headers = parseJson(decryptSecret(row.headers_enc), {});
  return {
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: parseJson(row.args, []),
    env: parseJson(row.env, {}),
    cwd: row.cwd,
    url: row.url,
    headers,
  };
}

export async function connect(id) {
  const row = get('SELECT * FROM connectors WHERE id = ?', id);
  if (!row) throw new Error('Connector not found');
  if (!row.enabled) throw new Error(`Connector "${row.name}" is disabled`);

  const cached = clients.get(id);
  if (cached?.initialized) return cached;

  const client = new McpClient(specFor(row));
  try {
    const tools = await client.initialize();
    clients.set(id, client);
    run(
      'UPDATE connectors SET last_status = ?, last_error = ?, tool_cache = ?, updated_at = ? WHERE id = ?',
      'connected',
      '',
      JSON.stringify(tools),
      now(),
      id,
    );
    log.info(`connector "${row.name}" ready with ${tools.length} tool(s)`);
    return client;
  } catch (error) {
    client.close();
    run(
      'UPDATE connectors SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?',
      'error',
      String(error.message).slice(0, 1000),
      now(),
      id,
    );
    throw error;
  }
}

export function disconnect(id) {
  const client = clients.get(id);
  if (client) {
    client.close();
    clients.delete(id);
  }
}

export function disconnectAll() {
  for (const id of [...clients.keys()]) disconnect(id);
}

export async function testConnector(id) {
  try {
    const client = await connect(id);
    return { ok: true, tools: client.tools };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function callConnectorTool(connectorId, toolName, args, { timeoutMs } = {}) {
  const client = await connect(connectorId);
  return client.callTool(toolName, args, { timeoutMs });
}

/**
 * Reads an existing Cursor / Claude Desktop `mcp.json` and turns every server
 * into a GrotFoxy connector, so a machine that already has MCP set up inherits
 * its whole connector catalogue in one click.
 */
export function importFromMcpJson(source) {
  const raw = typeof source === 'string' && source.trim().startsWith('{')
    ? source
    : fs.readFileSync(source, 'utf8');
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers ?? parsed.servers ?? {};
  const imported = [];
  const skipped = [];

  for (const [name, spec] of Object.entries(servers)) {
    const normalized = normalizeName(name);
    if (getConnectorByName(normalized)) {
      skipped.push({ name: normalized, reason: 'already exists' });
      continue;
    }
    const isHttp = Boolean(spec.url) && !spec.command;
    imported.push(
      createConnector({
        name: normalized,
        label: name,
        transport: isHttp ? 'http' : 'stdio',
        command: spec.command ?? '',
        args: spec.args ?? [],
        env: spec.env ?? {},
        cwd: spec.cwd ?? '',
        url: spec.url ?? '',
        headers: spec.headers ?? undefined,
        // Imported servers start disabled: their commands reference paths that
        // may not exist on this host, and a broken spawn on every run is worse
        // than an explicit opt-in.
        enabled: false,
      }),
    );
  }
  return { imported, skipped };
}

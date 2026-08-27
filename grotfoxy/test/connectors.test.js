import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';

import bootstrap from '../src/bootstrap.js';
import { startFakeModel, waitForRun } from './helpers/fake-model.js';
import {
  createConnector,
  disconnectAll,
  importFromMcpJson,
  listConnectors,
  testConnector,
} from '../src/services/connectors.js';
import { createProvider } from '../src/services/providers.js';
import { createBot } from '../src/services/bots.js';
import { getRun, loadMessages } from '../src/services/runs.js';
import { startRun } from '../src/runtime/runner.js';
import { buildToolset } from '../src/tools/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, 'helpers', 'fake-mcp-server.js');

let connectorId;

before(() => {
  bootstrap();
  connectorId = createConnector({
    name: 'fixture',
    label: 'Fixture Server',
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    enabled: true,
  }).id;
});

after(() => {
  disconnectAll();
});

describe('mcp connectors', () => {
  test('connects, lists tools and caches them', async () => {
    const result = await testConnector(connectorId);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      ['add', 'echo'],
    );

    const stored = listConnectors().find((entry) => entry.id === connectorId);
    assert.equal(stored.lastStatus, 'connected');
    assert.equal(stored.tools.length, 2);
  });

  test('reports a failure instead of throwing when the server cannot start', async () => {
    const broken = createConnector({
      name: 'broken',
      command: path.join(here, 'helpers', 'does-not-exist.js'),
      args: [],
      enabled: true,
    });
    const result = await testConnector(broken.id);
    assert.equal(result.ok, false);
    assert.ok(result.error.length > 0);

    const stored = listConnectors().find((entry) => entry.id === broken.id);
    assert.equal(stored.lastStatus, 'error');
  });

  test('exposes connector tools to a bot under a model-safe name', async () => {
    const bot = createBot({
      name: 'Connected',
      tools: ['get_current_time'],
      connectors: [connectorId],
    });
    const { tools, handlers } = await buildToolset(bot);
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes('mcp_fixture_echo'));
    assert.ok(names.includes('mcp_fixture_add'));
    for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);

    const handler = handlers.get('mcp_fixture_add');
    assert.equal(handler.kind, 'mcp');
    // Connector tools default to needing approval; they reach outside the box.
    assert.equal(handler.sensitivity, 'sensitive');
  });

  test('a bot actually calls a connector tool during a run', async () => {
    const model = await startFakeModel([
      { toolCalls: [{ name: 'mcp_fixture_add', arguments: { a: 20, b: 22 } }] },
      { content: 'The answer is 42.' },
    ]);
    const provider = createProvider({
      name: 'Fake mcp',
      kind: 'openai',
      baseUrl: model.baseUrl,
      apiKey: 'k',
      defaultModel: 'fake',
    });
    const bot = createBot({
      name: 'Adder',
      providerId: provider.id,
      model: 'fake',
      tools: [],
      connectors: [connectorId],
      approvalPolicy: 'never',
    });

    const started = startRun({ botId: bot.id, task: 'Add 20 and 22.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    const toolMessage = loadMessages(finished.id).find((message) => message.role === 'tool');
    assert.equal(toolMessage.content, '42');
    assert.equal(finished.result, 'The answer is 42.');
    await model.close();
  });

  test('a run degrades rather than dies when a connector is unavailable', async () => {
    const broken = createConnector({
      name: 'offline-server',
      command: path.join(here, 'helpers', 'nope.js'),
      enabled: true,
    });
    const bot = createBot({ name: 'Degraded', tools: ['get_current_time'], connectors: [broken.id] });

    const { tools, connectorIssues } = await buildToolset(bot);
    assert.deepEqual(tools.map((tool) => tool.name), ['get_current_time']);
    assert.equal(connectorIssues.length, 1);
    assert.equal(connectorIssues[0].name, 'offline-server');
  });
});

describe('mcp.json import', () => {
  test('imports every server and leaves them disabled', () => {
    const result = importFromMcpJson(
      JSON.stringify({
        mcpServers: {
          'Google Home': { command: 'npx', args: ['tsx', 'mcp/server.ts'], cwd: 'C:/x/google-home-api' },
          composio: { url: 'https://connect.composio.dev/mcp' },
        },
      }),
    );

    assert.equal(result.imported.length, 2);
    const home = result.imported.find((entry) => entry.name === 'google-home');
    assert.ok(home, 'names should be normalised for tool naming');
    assert.equal(home.transport, 'stdio');
    assert.deepEqual(home.args, ['tsx', 'mcp/server.ts']);
    assert.equal(home.enabled, false, 'imported servers must not auto-start');

    const composio = result.imported.find((entry) => entry.name === 'composio');
    assert.equal(composio.transport, 'http');
    assert.equal(composio.url, 'https://connect.composio.dev/mcp');
  });

  test('skips servers that already exist rather than duplicating them', () => {
    const payload = JSON.stringify({ mcpServers: { fixture: { command: 'node' } } });
    const result = importFromMcpJson(payload);
    assert.equal(result.imported.length, 0);
    assert.equal(result.skipped[0].name, 'fixture');
  });
});

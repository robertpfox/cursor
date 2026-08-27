import './helpers/env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';

// Set before importing config so the kill switch is in effect for this file.
process.env.GROTFOXY_DISABLE_TOOLS = 'run_command, delete_file';

const { default: bootstrap } = await import('../src/bootstrap.js');
const { buildToolset, isToolDisabled, toolCatalog } = await import('../src/tools/index.js');
const { createBot } = await import('../src/services/bots.js');

before(() => {
  bootstrap();
});

describe('instance-wide tool kill switch', () => {
  test('reports which tools are disabled', () => {
    assert.equal(isToolDisabled('run_command'), true);
    assert.equal(isToolDisabled('delete_file'), true, 'the list should be comma and space tolerant');
    assert.equal(isToolDisabled('read_file'), false);
  });

  test('flags them in the catalogue so the UI can lock them', () => {
    const catalog = toolCatalog();
    assert.equal(catalog.find((tool) => tool.name === 'run_command').disabled, true);
    assert.equal(catalog.find((tool) => tool.name === 'read_file').disabled, false);
  });

  test('withholds them from a bot that explicitly asks for them', async () => {
    const bot = createBot({
      name: 'Would-be shell user',
      tools: ['get_current_time', 'read_file', 'run_command', 'delete_file'],
    });
    const { tools, handlers } = await buildToolset(bot);
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ['get_current_time', 'read_file']);
    assert.equal(handlers.has('run_command'), false, 'no handler means it cannot be invoked at all');
    assert.equal(handlers.has('delete_file'), false);
  });

  test('cannot be re-enabled by editing the bot', async () => {
    // The whole point: enforcement lives in the runtime, not in bot config, so
    // anyone with the password still cannot turn shell access back on.
    const bot = createBot({ name: 'Persistent', tools: ['run_command'] });
    const { handlers } = await buildToolset({ ...bot, tools: ['run_command'] });
    assert.equal(handlers.has('run_command'), false);
  });
});

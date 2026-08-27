import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import bootstrap from '../src/bootstrap.js';
import { startFakeModel, waitForRun } from './helpers/fake-model.js';
import { createProvider } from '../src/services/providers.js';
import { createBot, getBot, updateBot } from '../src/services/bots.js';
import { getRun, listRuns } from '../src/services/runs.js';
import { tick } from '../src/runtime/scheduler.js';

let model;
let providerId;

before(async () => {
  bootstrap();
  model = await startFakeModel(Array.from({ length: 20 }, () => ({ content: 'Scheduled job done.' })));
  providerId = createProvider({
    name: 'Fake sched',
    kind: 'openai',
    baseUrl: model.baseUrl,
    apiKey: 'k',
    defaultModel: 'fake-model-1',
  }).id;
});

after(async () => {
  await model?.close();
});

function scheduledBot(overrides = {}) {
  return createBot({
    name: 'Scheduled',
    providerId,
    model: 'fake-model-1',
    tools: [],
    approvalPolicy: 'never',
    scheduleCron: '*/5 * * * *',
    scheduleTask: 'Do the recurring thing.',
    scheduleOn: true,
    ...overrides,
  });
}

describe('scheduler', () => {
  test('sets a next run time when a schedule is enabled', () => {
    const bot = scheduledBot();
    assert.ok(bot.nextRunAt, 'a scheduled bot needs a next run time');
    assert.ok(Date.parse(bot.nextRunAt) > Date.now());
  });

  test('fires a bot whose time has come, using its standing task', async () => {
    const bot = scheduledBot({ name: 'Due now' });
    // Pretend the slot already passed.
    updateBot(bot.id, {});
    const past = new Date(Date.now() - 60_000).toISOString();
    const { run: exec } = await import('../src/db/index.js');
    exec('UPDATE bots SET next_run_at = ? WHERE id = ?', past, bot.id);

    const fired = tick(new Date());
    assert.ok(fired >= 1);

    const runs = listRuns({ botId: bot.id });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'schedule');
    assert.equal(runs[0].task, 'Do the recurring thing.');

    const finished = await waitForRun(getRun, runs[0].id);
    assert.equal(finished.status, 'succeeded');
  });

  test('advances the schedule before running, so one slot cannot double-fire', async () => {
    const bot = scheduledBot({ name: 'No double fire' });
    const { run: exec } = await import('../src/db/index.js');
    exec('UPDATE bots SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), bot.id);

    tick(new Date());
    tick(new Date());

    assert.equal(listRuns({ botId: bot.id }).length, 1);
    assert.ok(Date.parse(getBot(bot.id).nextRunAt) > Date.now());
  });

  test('skips paused and unscheduled bots', async () => {
    const paused = scheduledBot({ name: 'Paused', enabled: false });
    const unscheduled = createBot({ name: 'Manual only', providerId, model: 'fake-model-1' });
    const { run: exec } = await import('../src/db/index.js');
    exec('UPDATE bots SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), paused.id);

    tick(new Date());

    assert.equal(listRuns({ botId: paused.id }).length, 0);
    assert.equal(listRuns({ botId: unscheduled.id }).length, 0);
    assert.equal(getBot(unscheduled.id).nextRunAt, null);
  });

  test('turning a schedule off clears the next run time', () => {
    const bot = scheduledBot({ name: 'Turned off' });
    assert.ok(bot.nextRunAt);
    const updated = updateBot(bot.id, { scheduleOn: false });
    assert.equal(updated.nextRunAt, null);
    assert.equal(updated.scheduleOn, false);
  });
});

import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import bootstrap from '../src/bootstrap.js';
import { startFakeModel, waitForRun } from './helpers/fake-model.js';
import { createProvider } from '../src/services/providers.js';
import { botWorkspace, createBot, updateBot } from '../src/services/bots.js';
import { getRun, listSteps, loadMessages } from '../src/services/runs.js';
import { decideApproval, listPending } from '../src/services/approvals.js';
import { resumeRun, startRun } from '../src/runtime/runner.js';

let model;
let providerId;

const ALL_TOOLS = [
  'get_current_time',
  'ask_user',
  'notify_user',
  'remember',
  'recall',
  'list_files',
  'read_file',
  'write_file',
];

function makeBot(overrides = {}) {
  return createBot({
    name: 'Test Teammate',
    job: 'Do exactly what the test asks.',
    providerId,
    model: 'fake-model-1',
    tools: ALL_TOOLS,
    approvalPolicy: 'never',
    maxSteps: 10,
    maxSeconds: 60,
    maxCostUsd: 0,
    ...overrides,
  });
}

before(async () => {
  bootstrap();
  model = await startFakeModel([]);
  providerId = createProvider({
    name: 'Fake',
    kind: 'openai',
    baseUrl: model.baseUrl,
    apiKey: 'test-key',
    defaultModel: 'fake-model-1',
  }).id;
});

after(async () => {
  await model?.close();
});

describe('agent runtime', () => {
  test('completes a run that uses a tool and then answers', async () => {
    const local = await startFakeModel([
      { content: 'Let me check the time first.', toolCalls: [{ name: 'get_current_time', arguments: {} }] },
      { content: 'All done. The clock is working.' },
    ]);
    const provider = createProvider({
      name: 'Fake tool run',
      kind: 'openai',
      baseUrl: local.baseUrl,
      apiKey: 'k',
      defaultModel: 'fake-model-1',
    });
    const bot = makeBot({ providerId: provider.id });

    const started = startRun({ botId: bot.id, task: 'Tell me the time.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result, 'All done. The clock is working.');
    assert.equal(finished.stepsUsed, 2);
    assert.equal(finished.tokensIn, 200, 'usage from both model calls should accumulate');

    const messages = loadMessages(finished.id);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[3].role, 'tool');
    assert.ok(messages[3].content.includes('ISO (UTC)'));

    const kinds = listSteps(finished.id).map((step) => step.kind);
    assert.ok(kinds.includes('tool'));
    assert.ok(kinds.includes('result'));

    // The tool result must be fed back to the model on the second call.
    const secondCall = local.requests[1];
    assert.ok(secondCall.messages.some((message) => message.role === 'tool'));
    await local.close();
  });

  test('writes a file through the tool layer and reports it', async () => {
    const local = await startFakeModel([
      {
        toolCalls: [{ name: 'write_file', arguments: { path: 'report.md', content: '# Findings\nAll good.' } }],
      },
      { content: 'Saved the report to report.md.' },
    ]);
    const provider = createProvider({ name: 'Fake files', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Writer' });

    const started = startRun({ botId: bot.id, task: 'Write a report.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    const written = path.join(botWorkspace(bot.id), 'report.md');
    assert.ok(fs.existsSync(written), 'file should exist in the bot workspace');
    assert.equal(fs.readFileSync(written, 'utf8'), '# Findings\nAll good.');
    await local.close();
  });

  test('a path escape becomes a tool error the bot can recover from', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: '../../../../etc/passwd' } }] },
      { content: 'I cannot read outside my workspace, so I stopped.' },
    ]);
    const provider = createProvider({ name: 'Fake jail', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Nosy' });

    const started = startRun({ botId: bot.id, task: 'Read the password file.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    const toolMessage = loadMessages(finished.id).find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /escapes the bot workspace/);
    // The run continues rather than crashing, and the model sees the refusal.
    assert.match(finished.result, /cannot read outside/);
    await local.close();
  });
});

describe('approval gates', () => {
  test('pauses on a sensitive tool, then resumes and finishes when approved', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'approved.txt', content: 'ok' } }] },
      { content: 'Wrote the file after you approved it.' },
    ]);
    const provider = createProvider({ name: 'Fake approve', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Careful', approvalPolicy: 'sensitive' });

    const started = startRun({ botId: bot.id, task: 'Write approved.txt.' });
    const paused = await waitForRun(getRun, started.id);

    assert.equal(paused.status, 'awaiting_approval');
    assert.equal(local.callCount(), 1, 'the model must not be called again while blocked');

    const pending = listPending().filter((entry) => entry.runId === started.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'write_file');
    assert.equal(pending[0].args.path, 'approved.txt');

    decideApproval(pending[0].id, 'approved', { note: 'go ahead' });
    resumeRun(started.id);

    const finished = await waitForRun(getRun, started.id);
    assert.equal(finished.status, 'succeeded');
    assert.ok(fs.existsSync(path.join(botWorkspace(bot.id), 'approved.txt')));
    assert.equal(fs.readFileSync(path.join(botWorkspace(bot.id), 'approved.txt'), 'utf8'), 'ok');
    await local.close();
  });

  test('a denial is reported back to the bot and the tool never runs', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'denied.txt', content: 'nope' } }] },
      { content: 'Understood, I did not write it.' },
    ]);
    const provider = createProvider({ name: 'Fake deny', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Blocked', approvalPolicy: 'sensitive' });

    const started = startRun({ botId: bot.id, task: 'Write denied.txt.' });
    await waitForRun(getRun, started.id);

    const pending = listPending().filter((entry) => entry.runId === started.id);
    decideApproval(pending[0].id, 'denied', { note: 'not that file' });
    resumeRun(started.id);

    const finished = await waitForRun(getRun, started.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(
      fs.existsSync(path.join(botWorkspace(bot.id), 'denied.txt')),
      false,
      'a denied tool must not execute',
    );

    const toolMessage = loadMessages(finished.id).find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /denied this action/);
    assert.match(toolMessage.content, /not that file/);
    await local.close();
  });

  test('ask_user pauses for an answer and hands it back verbatim', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which folder should I use?' } }] },
      { content: 'Thanks, using the Reports folder.' },
    ]);
    const provider = createProvider({ name: 'Fake ask', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Asker', approvalPolicy: 'never' });

    const started = startRun({ botId: bot.id, task: 'File the report.' });
    const paused = await waitForRun(getRun, started.id);

    // ask_user pauses even under a never-ask policy, because guessing is worse.
    assert.equal(paused.status, 'awaiting_input');
    const pending = listPending().filter((entry) => entry.runId === started.id);
    assert.equal(pending[0].kind, 'question');
    assert.equal(pending[0].reason, 'Which folder should I use?');

    decideApproval(pending[0].id, 'answered', { note: 'Use the Reports folder' });
    resumeRun(started.id);

    const finished = await waitForRun(getRun, started.id);
    assert.equal(finished.status, 'succeeded');
    const toolMessage = loadMessages(finished.id).find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /Use the Reports folder/);
    await local.close();
  });

  test('with parallel calls allowed, only the blocked one pauses and resume does not re-run the other', async () => {
    const local = await startFakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'get_current_time', arguments: {} },
          { id: 'c2', name: 'write_file', arguments: { path: 'second.txt', content: 'x' } },
        ],
      },
      { content: 'Both handled.' },
    ]);
    const provider = createProvider({ name: 'Fake partial', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({
      providerId: provider.id,
      name: 'Partial',
      approvalPolicy: 'sensitive',
      parallelTools: true,
    });

    const started = startRun({ botId: bot.id, task: 'Do two things.' });
    const paused = await waitForRun(getRun, started.id);
    assert.equal(paused.status, 'awaiting_approval');

    const answered = loadMessages(started.id).filter((message) => message.role === 'tool');
    assert.equal(answered.length, 1, 'the safe call should already have a result');
    assert.equal(answered[0].toolCallId, 'c1');

    const pending = listPending().filter((entry) => entry.runId === started.id);
    assert.equal(pending[0].toolCallId, 'c2');

    decideApproval(pending[0].id, 'approved', {});
    resumeRun(started.id);

    const finished = await waitForRun(getRun, started.id);
    assert.equal(finished.status, 'succeeded');
    // Resuming must not re-run the first tool; exactly two results in total.
    assert.equal(loadMessages(finished.id).filter((message) => message.role === 'tool').length, 2);
    assert.ok(fs.existsSync(path.join(botWorkspace(bot.id), 'second.txt')));
    await local.close();
  });
});

describe('sequential tool calls', () => {
  test('defers extra calls so the second can use the first one\u2019s result', async () => {
    const local = await startFakeModel([
      // A small model asking for both at once, with a placeholder it cannot fill.
      {
        toolCalls: [
          { id: 'c1', name: 'get_current_time', arguments: {} },
          { id: 'c2', name: 'write_file', arguments: { path: 'note.txt', content: 'checked at [time]' } },
        ],
      },
      { toolCalls: [{ id: 'c3', name: 'write_file', arguments: { path: 'note.txt', content: 'checked at 09:00' } }] },
      { content: 'Wrote the note with the real time.' },
    ]);
    const provider = createProvider({ name: 'Fake sequential', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Sequential', approvalPolicy: 'never' });
    assert.equal(bot.parallelTools, false, 'sequential should be the default');

    const started = startRun({ botId: bot.id, task: 'Note the time.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');

    const toolMessages = loadMessages(finished.id).filter((message) => message.role === 'tool');
    const deferred = toolMessages.find((message) => message.toolCallId === 'c2');
    assert.match(deferred.content, /one tool per turn/, 'the deferred call needs an explanatory result');
    assert.match(deferred.content, /get_current_time` has already run/, 'it must say what not to repeat');
    assert.match(deferred.content, /call `write_file` on its own/, 'it must say what to do next');

    // The placeholder write must never have reached disk; the retry did.
    assert.equal(
      fs.readFileSync(path.join(botWorkspace(bot.id), 'note.txt'), 'utf8'),
      'checked at 09:00',
    );

    const warning = listSteps(finished.id).find((step) => step.kind === 'warning');
    assert.match(warning.title, /Deferred 1 parallel tool call/);
    await local.close();
  });

  test('pushes back when the model answers without running a deferred call', async () => {
    const local = await startFakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'get_current_time', arguments: {} },
          { id: 'c2', name: 'read_file', arguments: { path: 'notes.md' } },
        ],
      },
      // Fabricates the file contents instead of re-requesting the read.
      { content: 'notes.md says the server is healthy.' },
      { toolCalls: [{ id: 'c3', name: 'read_file', arguments: { path: 'notes.md' } }] },
      { content: 'notes.md actually says: real contents.' },
    ]);
    const provider = createProvider({ name: 'Fake fabricate', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Fabricator', approvalPolicy: 'never' });
    fs.writeFileSync(path.join(botWorkspace(bot.id), 'notes.md'), 'real contents');

    const started = startRun({ botId: bot.id, task: 'Read notes.md.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result, 'notes.md actually says: real contents.');

    const nudge = loadMessages(finished.id).filter((message) => message.role === 'user').at(-1);
    assert.match(nudge.content, /have not run `read_file` yet/);
    assert.match(nudge.content, /Call it now/, 'the push-back should lead with the action');

    const warning = listSteps(finished.id).find((step) =>
      step.title.includes('without running a deferred tool'),
    );
    assert.ok(warning, 'the push-back should be visible in the timeline');
    await local.close();
  });

  test('pushes back only once, so a stubborn model still finishes', async () => {
    const local = await startFakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'get_current_time', arguments: {} },
          { id: 'c2', name: 'read_file', arguments: { path: 'notes.md' } },
        ],
      },
      { content: 'First guess.' },
      { content: 'I could not check the file.' },
    ]);
    const provider = createProvider({ name: 'Fake stubborn', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Stubborn', approvalPolicy: 'never' });

    const started = startRun({ botId: bot.id, task: 'Read notes.md.' });
    const finished = await waitForRun(getRun, started.id);

    // Not a clean success: we know for certain the read never happened.
    assert.equal(finished.status, 'incomplete');
    assert.equal(finished.result, 'I could not check the file.');
    assert.match(finished.error, /read_file was requested but never ran/);
    assert.match(finished.error, /stronger model/);
    assert.ok(
      listSteps(finished.id).some((step) => step.title === 'Finished without running every tool'),
      'the timeline must not claim a budget limit was hit',
    );
    assert.equal(
      listSteps(finished.id).filter((step) => step.title.includes('without running a deferred tool')).length,
      1,
      'a second push-back would risk an infinite loop',
    );
    await local.close();
  });

  test('remembers a deferred call across an approval pause', async () => {
    const local = await startFakeModel([
      {
        toolCalls: [
          { id: 'c1', name: 'write_file', arguments: { path: 'first.txt', content: 'a' } },
          { id: 'c2', name: 'read_file', arguments: { path: 'first.txt' } },
        ],
      },
      { content: 'Both done.' },
      { content: 'I could not read it.' },
    ]);
    const provider = createProvider({ name: 'Fake resume defer', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Resumer', approvalPolicy: 'sensitive' });

    const started = startRun({ botId: bot.id, task: 'Write then read.' });
    const paused = await waitForRun(getRun, started.id);
    assert.equal(paused.status, 'awaiting_approval');

    const pending = listPending().filter((entry) => entry.runId === started.id);
    decideApproval(pending[0].id, 'approved', {});
    // A fresh execute() pass: the deferral must be recovered from the
    // transcript, not from state that died with the previous pass.
    resumeRun(started.id);

    const finished = await waitForRun(getRun, started.id);
    assert.equal(finished.status, 'incomplete');
    assert.match(finished.error, /read_file was requested but never ran/);
    await local.close();
  });

  test('a single tool call is unaffected', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'get_current_time', arguments: {} }] },
      { content: 'Checked.' },
    ]);
    const provider = createProvider({ name: 'Fake single', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Single', approvalPolicy: 'never' });

    const started = startRun({ botId: bot.id, task: 'Check the time.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    assert.equal(listSteps(finished.id).filter((step) => step.kind === 'warning').length, 0);
    await local.close();
  });
});

describe('budgets', () => {
  test('stops at the step ceiling and asks for a wrap-up report', async () => {
    // Three tool-calling turns exhaust maxSteps; the fourth call is the
    // tool-free wrap-up the runtime asks for.
    const looping = Array.from({ length: 3 }, () => ({
      toolCalls: [{ name: 'get_current_time', arguments: {} }],
    }));
    const local = await startFakeModel([...looping, { content: 'Partial report: I kept checking the clock.' }]);
    const provider = createProvider({ name: 'Fake loop', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Looper', maxSteps: 3 });

    const started = startRun({ botId: bot.id, task: 'Loop forever.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'incomplete');
    assert.equal(finished.stepsUsed, 3);
    assert.match(finished.error, /step limit/);
    assert.equal(finished.result, 'Partial report: I kept checking the clock.');

    // The wrap-up must be asked without tools, or the model just keeps going.
    const wrapUpRequest = local.requests.at(-1);
    assert.equal(wrapUpRequest.tools, undefined);
    await local.close();
  });

  test('an empty wrap-up falls back to the last thing the bot said', async () => {
    const local = await startFakeModel([
      { content: 'Checked the clock once.', toolCalls: [{ name: 'get_current_time', arguments: {} }] },
      { content: null },
    ]);
    const provider = createProvider({ name: 'Fake silent', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Silent', maxSteps: 1 });

    const started = startRun({ botId: bot.id, task: 'Do something.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'incomplete');
    assert.match(finished.result, /stopped at its step limit/);
    assert.match(finished.result, /Checked the clock once\./);
    await local.close();
  });
});

describe('resilience', () => {
  test('a run interrupted mid-approval rehydrates from the database', async () => {
    const local = await startFakeModel([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'after-restart.txt', content: 'survived' } }] },
      { content: 'Finished after the restart.' },
    ]);
    const provider = createProvider({ name: 'Fake restart', kind: 'openai', baseUrl: local.baseUrl, apiKey: 'k' });
    const bot = makeBot({ providerId: provider.id, name: 'Survivor', approvalPolicy: 'always' });

    const started = startRun({ botId: bot.id, task: 'Write after-restart.txt.' });
    await waitForRun(getRun, started.id);

    const pending = listPending().filter((entry) => entry.runId === started.id);
    decideApproval(pending[0].id, 'approved', {});

    // resumeRun rebuilds the whole conversation from run_messages, which is the
    // same path taken after the host reboots.
    resumeRun(started.id);
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'succeeded');
    assert.equal(
      fs.readFileSync(path.join(botWorkspace(bot.id), 'after-restart.txt'), 'utf8'),
      'survived',
    );

    const systemMessages = loadMessages(finished.id).filter((message) => message.role === 'system');
    assert.equal(systemMessages.length, 1, 'resuming must not duplicate the system prompt');
    await local.close();
  });

  test('a down model server fails fast with an actionable message', async () => {
    // A closed port stands in for "Ollama is not running", the most common
    // local failure. It must not sit through the retry ladder first.
    const provider = createProvider({
      name: 'Unreachable',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:45999/v1',
      apiKey: 'k',
    });
    const bot = makeBot({ providerId: provider.id, name: 'Offline' });

    const startedAt = Date.now();
    const started = startRun({ botId: bot.id, task: 'Anything.' });
    const finished = await waitForRun(getRun, started.id, { timeoutMs: 15_000 });

    assert.equal(finished.status, 'failed');
    assert.match(finished.error, /ECONNREFUSED/);
    assert.match(finished.error, /is the server running/);
    assert.ok(Date.now() - startedAt < 5000, 'a refused connection should not be retried');
  });

  test('a rate limit is retried rather than surfaced immediately', async () => {
    let calls = 0;
    const flaky = http.createServer((req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Recovered after the rate limit.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      );
    });
    await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve));
    flaky.unref();

    const provider = createProvider({
      name: 'Flaky',
      kind: 'openai',
      baseUrl: `http://127.0.0.1:${flaky.address().port}`,
      apiKey: 'k',
    });
    const bot = makeBot({ providerId: provider.id, name: 'Patient' });

    const started = startRun({ botId: bot.id, task: 'Anything.' });
    const finished = await waitForRun(getRun, started.id, { timeoutMs: 15_000 });

    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result, 'Recovered after the rate limit.');
    assert.equal(calls, 2, 'the 429 should have been retried exactly once');

    flaky.closeAllConnections();
    await new Promise((resolve) => flaky.close(resolve));
  });

  test('a bot with no provider fails with actionable guidance', async () => {
    // New bots inherit the first enabled provider, so clear it explicitly.
    const bot = updateBot(makeBot({ name: 'Brainless' }).id, { providerId: null });
    const started = startRun({ botId: bot.id, task: 'Anything.' });
    const finished = await waitForRun(getRun, started.id);

    assert.equal(finished.status, 'failed');
    assert.match(finished.error, /Settings/);
  });
});

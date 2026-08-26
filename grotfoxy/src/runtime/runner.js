import config from '../config.js';
import bus from '../core/events.js';
import log from '../core/logger.js';
import { chat } from '../llm/index.js';
import { buildSystemPrompt } from './prompt.js';
import { buildToolset, findBuiltinTool } from '../tools/index.js';
import { botWorkspace, getBot } from '../services/bots.js';
import { resolveProvider } from '../services/providers.js';
import { notify } from '../services/notifications.js';
import {
  cancelPendingForRun,
  createApproval,
  findForToolCall,
} from '../services/approvals.js';
import {
  addStep,
  addUsage,
  appendMessage,
  createRun,
  createThread,
  getRun,
  listRuns,
  listSteps,
  loadMessages,
  recordDailyUsage,
  touchThread,
  updateRun,
} from '../services/runs.js';

/** Runs currently executing, so they can be cancelled mid-flight. */
const active = new Map();
/** Runs waiting for a worker slot. */
const queue = [];

export function activeRunCount() {
  return active.size;
}

export function queuedRunCount() {
  return queue.length;
}

export function isRunActive(runId) {
  return active.has(runId);
}

export function cancelRun(runId) {
  const entry = active.get(runId);
  if (entry) {
    entry.controller.abort();
    return true;
  }
  const queuedIndex = queue.findIndex((item) => item.runId === runId);
  if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
  const record = getRun(runId);
  if (record && !['succeeded', 'failed', 'cancelled', 'incomplete'].includes(record.status)) {
    cancelPendingForRun(runId);
    finishRun(runId, { status: 'cancelled', error: 'Cancelled by owner' });
    return true;
  }
  return false;
}

/**
 * Queue a fresh task for a bot. Returns immediately with the run record; the
 * work happens in the background exactly like Grok Bot's "give it a job and
 * walk away" model.
 */
export function startRun({ botId, task, trigger = 'manual', threadId = null, parentRunId = null }) {
  const bot = getBot(botId);
  if (!bot) throw new Error('Bot not found');
  if (!bot.enabled) throw new Error(`${bot.name} is paused. Enable the bot before giving it work.`);

  const thread = threadId ?? createThread(botId, String(task ?? '').slice(0, 80) || bot.name);
  const record = createRun({ botId, task, trigger, threadId: thread, parentRunId, model: bot.model });
  enqueue(record.id);
  return record;
}

/** Continue a run that paused for an approval, an answer, or a restart. */
export function resumeRun(runId) {
  const record = getRun(runId);
  if (!record) throw new Error('Run not found');
  if (active.has(runId) || queue.some((item) => item.runId === runId)) return record;
  if (['succeeded', 'failed', 'cancelled', 'incomplete'].includes(record.status)) return record;
  enqueue(runId);
  return getRun(runId);
}

function enqueue(runId) {
  queue.push({ runId });
  drain();
}

function drain() {
  while (active.size < config.maxConcurrentRuns && queue.length) {
    const { runId } = queue.shift();
    const controller = new AbortController();
    active.set(runId, { controller });
    execute(runId, controller.signal)
      .catch((error) => {
        log.error(`run ${runId} crashed: ${error.stack || error.message}`);
        finishRun(runId, { status: 'failed', error: String(error.message ?? error) });
      })
      .finally(() => {
        active.delete(runId);
        drain();
      });
  }
}

const DEFAULT_FINISH_TITLES = {
  succeeded: 'Finished',
  cancelled: 'Cancelled',
  incomplete: 'Stopped early',
  failed: 'Failed',
};

function finishRun(runId, { status, result = '', error = '', title }) {
  const record = updateRun(runId, { status, result, error, finishedAt: new Date().toISOString() });
  cancelPendingForRun(runId);
  addStep(runId, {
    kind: status === 'succeeded' ? 'result' : 'status',
    title: title ?? DEFAULT_FINISH_TITLES[status] ?? 'Finished',
    detail: result || error,
    status,
  });
  bus.publish('run.finished', { runId, botId: record.botId, run: record });
  return record;
}

async function maybeNotify(bot, record) {
  const policy = bot.notifyOn || 'always';
  if (policy === 'never') return;
  const failed = record.status !== 'succeeded';
  if (policy === 'failures' && !failed) return;
  await notify({
    botId: bot.id,
    runId: record.id,
    level: failed ? 'error' : 'success',
    title: `${bot.emoji ? `${bot.emoji} ` : ''}${bot.name}: ${
      record.status === 'succeeded' ? 'task finished' : record.status
    }`,
    body: (record.result || record.error || '').slice(0, 500),
  });
}

function summarizeArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function plural(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function needsApproval(policy, sensitivity) {
  if (sensitivity === 'ask') return true;
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return sensitivity === 'sensitive' || sensitivity === 'dangerous';
}

async function execute(runId, signal) {
  const record = getRun(runId);
  const bot = getBot(record.botId);
  if (!bot) return finishRun(runId, { status: 'failed', error: 'Bot no longer exists' });

  const provider = bot.providerId ? resolveProvider(bot.providerId) : null;
  if (!provider) {
    return finishRun(runId, {
      status: 'failed',
      error: 'No model provider is configured for this bot. Add one in Settings → Models.',
    });
  }
  const model = bot.model || provider.defaultModel;
  if (!model) {
    return finishRun(runId, { status: 'failed', error: 'No model selected for this bot.' });
  }

  const startedAt = record.startedAt ?? new Date().toISOString();
  updateRun(runId, { status: 'running', startedAt, model });

  const { tools, handlers, connectorIssues } = await buildToolset(bot);
  const ctx = {
    bot,
    run: getRun(runId),
    workspaceDir: botWorkspace(bot.id),
    signal,
  };

  let messages = loadMessages(runId);
  if (!messages.length) {
    const system = buildSystemPrompt(bot, {
      toolNames: tools.map((tool) => tool.name),
      connectorIssues,
    });
    appendMessage(runId, { role: 'system', content: system });
    appendMessage(runId, { role: 'user', content: record.task || bot.scheduleTask || 'Do your job.' });
    messages = loadMessages(runId);
    addStep(runId, { kind: 'status', title: 'Started', detail: `Model: ${model}` });
    if (connectorIssues.length) {
      addStep(runId, {
        kind: 'warning',
        title: `${plural(connectorIssues.length, 'connector')} unavailable`,
        detail: connectorIssues.map((issue) => `${issue.name}: ${issue.error}`).join('\n'),
        status: 'warning',
      });
    }
  } else {
    addStep(runId, { kind: 'status', title: 'Resumed', detail: '' });
  }

  const deadline = Date.parse(startedAt) + bot.maxSeconds * 1000;
  let stepsUsed = getRun(runId).stepsUsed;
  /** Tool names this run asked for but had deferred, and has not since run. */
  const deferred = new Set();
  let nudgedAboutDeferred = false;

  // Finish any tool calls the previous pass left unanswered before asking the
  // model for its next move. This is what makes a paused run resumable.
  const pending = pendingToolCalls(messages);
  if (pending.length) {
    const outcome = await runToolCalls({ runId, bot, ctx, handlers, calls: pending, signal, deferred });
    if (outcome.paused) return;
    messages = loadMessages(runId);
  }

  while (true) {
    if (signal.aborted) {
      return finishRun(runId, { status: 'cancelled', error: 'Cancelled by owner' });
    }
    if (stepsUsed >= bot.maxSteps) {
      return wrapUp(runId, bot, provider, model, messages, signal, `step limit (${bot.maxSteps})`);
    }
    if (Date.now() > deadline) {
      return wrapUp(runId, bot, provider, model, messages, signal, `time limit (${bot.maxSeconds}s)`);
    }
    const spent = getRun(runId).costUsd;
    if (bot.maxCostUsd > 0 && spent >= bot.maxCostUsd) {
      return wrapUp(runId, bot, provider, model, messages, signal, `cost limit ($${bot.maxCostUsd})`);
    }

    let response;
    const thinkingStarted = Date.now();
    try {
      response = await chat({
        provider,
        model,
        messages,
        tools,
        temperature: bot.temperature,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return finishRun(runId, { status: 'cancelled', error: 'Cancelled by owner' });
      addStep(runId, { kind: 'error', title: 'Model call failed', detail: error.message, status: 'error' });
      const failed = finishRun(runId, { status: 'failed', error: error.message });
      await maybeNotify(bot, failed);
      return failed;
    }

    stepsUsed += 1;
    updateRun(runId, { stepsUsed });
    addUsage(runId, {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.costUsd,
    });
    recordDailyUsage({
      provider: provider.name,
      model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.costUsd,
    });

    appendMessage(runId, response.message);
    messages = loadMessages(runId);

    if (!response.message.toolCalls?.length) {
      // A model that never re-ran a deferred call has, at best, guessed at what
      // it would have returned. Push back once before accepting the answer.
      if (deferred.size && !nudgedAboutDeferred) {
        nudgedAboutDeferred = true;
        const outstanding = [...deferred];
        appendMessage(runId, {
          role: 'user',
          content: [
            `Stop. You have not run ${outstanding.map((name) => `\`${name}\``).join(' or ')} yet, so you do not have ${
              outstanding.length === 1 ? 'its result' : 'those results'
            }.`,
            `Call ${outstanding.length === 1 ? 'it' : 'them'} now.`,
            'Only if the tool genuinely will not work for you, answer again and say plainly that you could not check. Never describe content you have not actually seen.',
          ].join(' '),
        });
        addStep(runId, {
          kind: 'warning',
          title: 'Answered without running a deferred tool',
          detail: `Asked the model to run ${outstanding.join(', ')} or admit it did not.`,
          status: 'warning',
        });
        messages = loadMessages(runId);
        continue;
      }

      const result = String(response.message.content ?? '').trim();
      recordDailyUsage({ provider: provider.name, model, countRun: true });

      // Already pushed back once and the tool still never ran. We cannot prove
      // the answer is invented, but we can prove it is not fully evidenced, so
      // it must not land as a clean success.
      const unrun = [...deferred];
      const finished = finishRun(runId, {
        status: unrun.length ? 'incomplete' : 'succeeded',
        title: unrun.length ? 'Finished without running every tool' : undefined,
        result: result || '(the model returned an empty reply)',
        error: unrun.length
          ? `${unrun.join(', ')} was requested but never ran, so anything above that depends on it is not backed by a tool result. If this keeps happening, give ${bot.name} a stronger model.`
          : '',
      });
      touchThread(record.threadId);
      await maybeNotify(bot, finished);
      return finished;
    }

    if (response.message.content?.trim()) {
      addStep(runId, {
        kind: 'thinking',
        title: 'Reasoning',
        detail: response.message.content.trim(),
        durationMs: Date.now() - thinkingStarted,
      });
    }

    const outcome = await runToolCalls({
      runId,
      bot,
      ctx,
      handlers,
      calls: response.message.toolCalls,
      signal,
      deferred,
    });
    if (outcome.paused) return;
    if (outcome.cancelled) return finishRun(runId, { status: 'cancelled', error: 'Cancelled by owner' });
    messages = loadMessages(runId);
  }
}

/** Tool calls from the last assistant turn that have no matching result yet. */
function pendingToolCalls(messages) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant?.toolCalls?.length) return [];
  const answered = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
  );
  return lastAssistant.toolCalls.filter((call) => !answered.has(call.id));
}

/**
 * Names what just ran, so the model does not simply repeat the whole batch on
 * its next turn. Without the "do not call it again" clause, small models loop:
 * they re-request both tools, the first runs a second time, and the dependent
 * one is deferred forever.
 */
function sequentialSkipNote(ranCall, skippedCall) {
  return [
    `Not run yet. This teammate executes one tool per turn so each call can use the previous result.`,
    `\`${ranCall.name}\` has already run and its result is in this conversation — do not call it again.`,
    `Your next turn should call \`${skippedCall.name}\` on its own, filling its arguments with the real values from that result rather than any placeholder.`,
  ].join(' ');
}

async function runToolCalls({ runId, bot, ctx, handlers, calls, signal, deferred }) {
  let queue = calls;

  // Answer the extras up front so the transcript stays complete even if the
  // first call pauses for approval; on resume only that call is outstanding.
  if (!bot.parallelTools && calls.length > 1) {
    const answered = new Set(
      loadMessages(runId)
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
    );
    for (const skipped of calls.slice(1)) {
      if (answered.has(skipped.id)) continue;
      deferred?.add(skipped.name);
      appendMessage(runId, {
        role: 'tool',
        toolCallId: skipped.id,
        name: skipped.name,
        content: sequentialSkipNote(calls[0], skipped),
      });
    }
    addStep(runId, {
      kind: 'warning',
      title: `Deferred ${plural(calls.length - 1, 'parallel tool call')}`,
      detail: `Running ${calls[0].name} first. ${calls
        .slice(1)
        .map((call) => call.name)
        .join(', ')} can be requested again once its result is in.`,
      status: 'warning',
    });
    queue = calls.slice(0, 1);
  }

  for (const call of queue) {
    if (signal.aborted) return { cancelled: true };

    const handler = handlers.get(call.name);
    if (!handler) {
      appendMessage(runId, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Error: no tool named "${call.name}" is available to you. Use one of the listed tools.`,
      });
      addStep(runId, {
        kind: 'error',
        title: `Unknown tool: ${call.name}`,
        detail: summarizeArgs(call.arguments),
        status: 'error',
      });
      continue;
    }

    const decision = findForToolCall(runId, call.id);

    if (decision?.status === 'denied') {
      appendMessage(runId, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Your owner denied this action.${decision.note ? ` They said: ${decision.note}` : ''} Do not retry it; find another way or explain why you cannot continue.`,
      });
      addStep(runId, { kind: 'approval', title: `Denied: ${call.name}`, detail: decision.note, status: 'denied' });
      continue;
    }

    if (decision?.status === 'answered') {
      appendMessage(runId, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Your owner answered: ${decision.note || '(no answer given)'}`,
      });
      addStep(runId, { kind: 'answer', title: 'Owner answered', detail: decision.note });
      continue;
    }

    if (decision?.status === 'cancelled') {
      appendMessage(runId, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: 'This request was cancelled.',
      });
      continue;
    }

    if (!decision) {
      // ask_user never executes; it exists purely to pause for a human answer.
      if (call.name === 'ask_user') {
        const question = String(call.arguments?.question ?? 'The bot needs input.');
        createApproval({
          runId,
          botId: bot.id,
          kind: 'question',
          toolName: 'ask_user',
          toolCallId: call.id,
          args: call.arguments,
          reason: question,
        });
        addStep(runId, { kind: 'question', title: 'Waiting for your answer', detail: question, status: 'pending' });
        updateRun(runId, { status: 'awaiting_input' });
        await notify({
          botId: bot.id,
          runId,
          level: 'warning',
          title: `${bot.name} has a question`,
          body: question,
        });
        return { paused: true };
      }

      if (needsApproval(bot.approvalPolicy, handler.sensitivity)) {
        const reason =
          handler.kind === 'mcp'
            ? `Use the ${handler.connectorName} connector (${handler.remoteName}).`
            : `Run ${call.name}.`;
        createApproval({
          runId,
          botId: bot.id,
          kind: 'approval',
          toolName: call.name,
          toolCallId: call.id,
          args: call.arguments,
          reason,
        });
        addStep(runId, {
          kind: 'approval',
          title: `Approval needed: ${call.name}`,
          detail: summarizeArgs(call.arguments),
          status: 'pending',
        });
        updateRun(runId, { status: 'awaiting_approval' });
        await notify({
          botId: bot.id,
          runId,
          level: 'warning',
          title: `${bot.name} needs approval`,
          body: `${reason}\n${summarizeArgs(call.arguments)}`,
        });
        return { paused: true };
      }
    }

    if (decision?.status === 'pending') {
      updateRun(runId, {
        status: decision.kind === 'question' ? 'awaiting_input' : 'awaiting_approval',
      });
      return { paused: true };
    }

    const started = Date.now();
    try {
      const result = await handler.execute(call.arguments ?? {}, { ...ctx, run: getRun(runId) });
      deferred?.delete(call.name);
      const output = String(result?.output ?? '');
      appendMessage(runId, { role: 'tool', toolCallId: call.id, name: call.name, content: output });
      addStep(runId, {
        kind: 'tool',
        title: call.name,
        detail: JSON.stringify({ args: call.arguments ?? {}, output: output.slice(0, 8000) }),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (signal.aborted) return { cancelled: true };
      const message = String(error?.message ?? error);
      appendMessage(runId, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Error: ${message}`,
      });
      addStep(runId, {
        kind: 'tool',
        title: call.name,
        detail: JSON.stringify({ args: call.arguments ?? {}, error: message }),
        status: 'error',
        durationMs: Date.now() - started,
      });
    }
  }
  return { paused: false };
}

/**
 * When a run hits a budget ceiling, spend one final tool-free call asking for a
 * summary. An honest partial report beats a silent stop.
 */
async function wrapUp(runId, bot, provider, model, messages, signal, reason) {
  addStep(runId, { kind: 'warning', title: `Reached ${reason}`, detail: 'Asking for a final summary.', status: 'warning' });
  try {
    const response = await chat({
      provider,
      model,
      messages: [
        ...messages,
        {
          role: 'user',
          content: `You have reached your ${reason}. Stop working now and reply with a final report: what you accomplished, what you found, and exactly what is left to do. No tool calls.`,
        },
      ],
      tools: [],
      temperature: bot.temperature,
      signal,
    });
    addUsage(runId, {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.costUsd,
    });
    const finished = finishRun(runId, {
      status: 'incomplete',
      result: response.message.content?.trim() || lastAssistantText(messages, reason),
      error: `Stopped at ${reason}`,
    });
    await maybeNotify(bot, finished);
    return finished;
  } catch (error) {
    const finished = finishRun(runId, {
      status: 'incomplete',
      result: lastAssistantText(messages, reason),
      error: `Stopped at ${reason}; the summary call also failed: ${error.message}`,
    });
    await maybeNotify(bot, finished);
    return finished;
  }
}

/**
 * Fallback when the wrap-up call comes back empty. Showing the bot's last words
 * beats showing "(no output)" on a run that clearly did work.
 */
function lastAssistantText(messages, reason) {
  const spoken = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content?.trim());
  const prefix = `This run stopped at its ${reason} before reaching a conclusion.`;
  return spoken ? `${prefix}\n\nIts last note was:\n\n${spoken.content.trim()}` : prefix;
}

/**
 * A run that was mid-flight when the host rebooted is stranded in `running`.
 * Requeue it: the transcript is on disk, so it picks up where it stopped.
 */
export function recoverInterruptedRuns() {
  const stranded = [
    ...listRuns({ status: 'running', limit: 200 }),
    ...listRuns({ status: 'queued', limit: 200 }),
  ];
  for (const record of stranded) {
    addStep(record.id, {
      kind: 'status',
      title: 'Recovered after restart',
      detail: 'GrotFoxy restarted while this run was active; resuming from the saved transcript.',
      status: 'warning',
    });
    resumeRun(record.id);
  }
  return stranded.length;
}

export { listSteps };

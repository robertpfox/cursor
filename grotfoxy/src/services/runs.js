import { all, get, now, parseJson, run as exec } from '../db/index.js';
import { newId } from '../core/crypto.js';
import bus from '../core/events.js';

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'incomplete'];
export const PAUSED_STATUSES = ['awaiting_approval', 'awaiting_input'];

export function toPublicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    parentRunId: row.parent_run_id,
    trigger: row.trigger,
    status: row.status,
    task: row.task,
    result: row.result,
    error: row.error,
    stepsUsed: row.steps_used,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    model: row.model,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createThread(botId, title) {
  const id = newId('thr');
  const timestamp = now();
  exec(
    'INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    botId,
    String(title ?? '').slice(0, 120),
    timestamp,
    timestamp,
  );
  return id;
}

export function touchThread(id) {
  if (id) exec('UPDATE threads SET updated_at = ? WHERE id = ?', now(), id);
}

export function listThreads(botId, limit = 30) {
  return all(
    'SELECT * FROM threads WHERE bot_id = ? ORDER BY updated_at DESC LIMIT ?',
    botId,
    limit,
  ).map((row) => ({
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function createRun({ botId, task, trigger = 'manual', threadId = null, parentRunId = null, model = '' }) {
  const id = newId('run');
  exec(
    `INSERT INTO runs (id, bot_id, thread_id, parent_run_id, trigger, status, task, model, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    id,
    botId,
    threadId,
    parentRunId,
    trigger,
    String(task ?? ''),
    model,
    now(),
  );
  const record = getRun(id);
  bus.publish('run.created', { runId: id, botId, run: record });
  return record;
}

export function getRun(id) {
  return toPublicRun(get('SELECT * FROM runs WHERE id = ?', id));
}

export function listRuns({ botId, threadId, status, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (botId) {
    clauses.push('bot_id = ?');
    params.push(botId);
  }
  if (threadId) {
    clauses.push('thread_id = ?');
    params.push(threadId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  ).map(toPublicRun);
}

export function updateRun(id, fields) {
  const columns = {
    status: 'status',
    result: 'result',
    error: 'error',
    stepsUsed: 'steps_used',
    tokensIn: 'tokens_in',
    tokensOut: 'tokens_out',
    costUsd: 'cost_usd',
    model: 'model',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    threadId: 'thread_id',
  };
  const assignments = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(fields[key]);
  }
  if (!assignments.length) return getRun(id);
  values.push(id);
  exec(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  const record = getRun(id);
  if (fields.status) {
    bus.publish('run.status', { runId: id, botId: record.botId, status: record.status, run: record });
  }
  return record;
}

export function addUsage(id, { inputTokens = 0, outputTokens = 0, costUsd = 0 }) {
  exec(
    'UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?',
    inputTokens,
    outputTokens,
    costUsd,
    id,
  );
}

export function appendMessage(runId, message) {
  const seq = (get('SELECT MAX(seq) AS m FROM run_messages WHERE run_id = ?', runId)?.m ?? -1) + 1;
  exec(
    `INSERT INTO run_messages (run_id, seq, role, content, tool_calls, tool_call_id, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    runId,
    seq,
    message.role,
    String(message.content ?? ''),
    message.toolCalls?.length ? JSON.stringify(message.toolCalls) : '',
    message.toolCallId ?? '',
    message.name ?? '',
    now(),
  );
  return seq;
}

export function loadMessages(runId) {
  return all('SELECT * FROM run_messages WHERE run_id = ? ORDER BY seq', runId).map((row) => ({
    role: row.role,
    content: row.content,
    toolCalls: parseJson(row.tool_calls, undefined),
    toolCallId: row.tool_call_id || undefined,
    name: row.name || undefined,
  }));
}

export function addStep(runId, step) {
  const seq = (get('SELECT MAX(seq) AS m FROM run_steps WHERE run_id = ?', runId)?.m ?? -1) + 1;
  exec(
    `INSERT INTO run_steps (run_id, seq, kind, title, detail, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    runId,
    seq,
    step.kind,
    String(step.title ?? '').slice(0, 500),
    typeof step.detail === 'string' ? step.detail : JSON.stringify(step.detail ?? ''),
    step.status ?? 'done',
    Math.round(step.durationMs ?? 0),
    now(),
  );
  const record = get('SELECT * FROM run_steps WHERE run_id = ? AND seq = ?', runId, seq);
  const payload = toPublicStep(record);
  bus.publish('run.step', { runId, step: payload });
  return payload;
}

export function toPublicStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    status: row.status,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export function listSteps(runId) {
  return all('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq', runId).map(toPublicStep);
}

export function deleteRun(id) {
  exec('DELETE FROM runs WHERE id = ?', id);
}

export function recordDailyUsage({ provider, model, inputTokens, outputTokens, costUsd, countRun = false }) {
  const day = new Date().toISOString().slice(0, 10);
  exec(
    `INSERT INTO usage_daily (day, provider, model, runs, tokens_in, tokens_out, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, provider, model) DO UPDATE SET
       runs = runs + excluded.runs,
       tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_usd = cost_usd + excluded.cost_usd`,
    day,
    provider || 'unknown',
    model || 'unknown',
    countRun ? 1 : 0,
    inputTokens ?? 0,
    outputTokens ?? 0,
    costUsd ?? 0,
  );
}

export function usageSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const totals = get(
    `SELECT COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(tokens_in),0) AS tokens_in,
            COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage_daily WHERE day >= ?`,
    since,
  );
  const byDay = all(
    `SELECT day, SUM(runs) AS runs, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
            SUM(cost_usd) AS cost_usd
       FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`,
    since,
  );
  const byModel = all(
    `SELECT model, provider, SUM(runs) AS runs, SUM(cost_usd) AS cost_usd
       FROM usage_daily WHERE day >= ? GROUP BY model, provider ORDER BY cost_usd DESC LIMIT 10`,
    since,
  );
  return { since, totals, byDay, byModel };
}

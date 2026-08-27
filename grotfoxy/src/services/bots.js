import fs from 'node:fs';
import path from 'node:path';
import { all, get, now, parseJson, run } from '../db/index.js';
import { newId, randomToken, tokenDigest } from '../core/crypto.js';
import config from '../config.js';
import { DEFAULT_TOOLS } from '../tools/index.js';
import { isValidCron, nextCronDate } from '../util/cron.js';
import { firstEnabledProvider } from './providers.js';

export function botWorkspace(botId) {
  const dir = path.join(config.workspaceDir, botId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function toPublicBot(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    job: row.job,
    context: row.context,
    boundaries: row.boundaries,
    providerId: row.provider_id,
    model: row.model,
    temperature: row.temperature,
    tools: parseJson(row.tools, []),
    connectors: parseJson(row.connectors, []),
    approvalPolicy: row.approval_policy,
    parallelTools: Boolean(row.parallel_tools),
    maxSteps: row.max_steps,
    maxSeconds: row.max_seconds,
    maxCostUsd: row.max_cost_usd,
    allowedHosts: parseJson(row.allowed_hosts, []),
    shellAllow: parseJson(row.shell_allow, []),
    shellDeny: parseJson(row.shell_deny, []),
    scheduleCron: row.schedule_cron,
    scheduleTask: row.schedule_task,
    scheduleOn: Boolean(row.schedule_on),
    nextRunAt: row.next_run_at,
    webhookOn: Boolean(row.webhook_on),
    hasWebhookToken: Boolean(row.webhook_digest),
    notifyOn: row.notify_on,
    enabled: Boolean(row.enabled),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBots({ includeArchived = false } = {}) {
  const rows = includeArchived
    ? all('SELECT * FROM bots ORDER BY created_at')
    : all('SELECT * FROM bots WHERE archived = 0 ORDER BY created_at');
  return rows.map(toPublicBot);
}

export function getBot(id) {
  return toPublicBot(get('SELECT * FROM bots WHERE id = ?', id));
}

function computeNextRun(scheduleOn, cron) {
  if (!scheduleOn || !cron || !isValidCron(cron)) return null;
  const next = nextCronDate(cron);
  return next ? next.toISOString() : null;
}

export function createBot(input = {}) {
  const id = newId('bot');
  const timestamp = now();
  const provider = input.providerId ? { id: input.providerId } : firstEnabledProvider();
  const scheduleCron = input.scheduleCron?.trim() ?? '';
  const scheduleOn = Boolean(input.scheduleOn) && isValidCron(scheduleCron);

  run(
    `INSERT INTO bots (
       id, name, emoji, color, job, context, boundaries, provider_id, model, temperature,
       tools, connectors, approval_policy, parallel_tools, max_steps, max_seconds, max_cost_usd,
       allowed_hosts, shell_allow, shell_deny, schedule_cron, schedule_task, schedule_on,
       next_run_at, notify_on, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name?.trim() || 'New teammate',
    input.emoji ?? '',
    input.color || '#f97316',
    input.job ?? '',
    input.context ?? '',
    input.boundaries ?? '',
    input.providerId ?? provider?.id ?? null,
    input.model?.trim() || provider?.defaultModel || '',
    Number.isFinite(input.temperature) ? input.temperature : 0.2,
    JSON.stringify(input.tools ?? DEFAULT_TOOLS),
    JSON.stringify(input.connectors ?? []),
    input.approvalPolicy || 'sensitive',
    input.parallelTools ? 1 : 0,
    clampInt(input.maxSteps, 1, 200, 25),
    clampInt(input.maxSeconds, 30, 21_600, 900),
    Number.isFinite(input.maxCostUsd) ? input.maxCostUsd : 1,
    JSON.stringify(input.allowedHosts ?? []),
    JSON.stringify(input.shellAllow ?? []),
    JSON.stringify(input.shellDeny ?? []),
    scheduleCron,
    input.scheduleTask ?? '',
    scheduleOn ? 1 : 0,
    computeNextRun(scheduleOn, scheduleCron),
    input.notifyOn || 'always',
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  botWorkspace(id);
  return getBot(id);
}

const UPDATABLE = {
  name: 'name',
  emoji: 'emoji',
  color: 'color',
  job: 'job',
  context: 'context',
  boundaries: 'boundaries',
  providerId: 'provider_id',
  model: 'model',
  temperature: 'temperature',
  approvalPolicy: 'approval_policy',
  maxSteps: 'max_steps',
  maxSeconds: 'max_seconds',
  maxCostUsd: 'max_cost_usd',
  scheduleTask: 'schedule_task',
  notifyOn: 'notify_on',
};

const JSON_FIELDS = {
  tools: 'tools',
  connectors: 'connectors',
  allowedHosts: 'allowed_hosts',
  shellAllow: 'shell_allow',
  shellDeny: 'shell_deny',
};

export function updateBot(id, input = {}) {
  const existing = get('SELECT * FROM bots WHERE id = ?', id);
  if (!existing) return null;

  const assignments = [];
  const values = [];

  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (input[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    if (key === 'maxSteps') values.push(clampInt(input[key], 1, 200, existing.max_steps));
    else if (key === 'maxSeconds') values.push(clampInt(input[key], 30, 21_600, existing.max_seconds));
    else values.push(input[key]);
  }
  for (const [key, column] of Object.entries(JSON_FIELDS)) {
    if (input[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(JSON.stringify(input[key]));
  }
  if (input.parallelTools !== undefined) {
    assignments.push('parallel_tools = ?');
    values.push(input.parallelTools ? 1 : 0);
  }
  for (const key of ['enabled', 'archived']) {
    if (input[key] === undefined) continue;
    assignments.push(`${key} = ?`);
    values.push(input[key] ? 1 : 0);
  }

  if (input.scheduleCron !== undefined || input.scheduleOn !== undefined) {
    const cron = (input.scheduleCron ?? existing.schedule_cron).trim();
    const on = (input.scheduleOn ?? Boolean(existing.schedule_on)) && isValidCron(cron);
    assignments.push('schedule_cron = ?', 'schedule_on = ?', 'next_run_at = ?');
    values.push(cron, on ? 1 : 0, computeNextRun(on, cron));
  }

  if (!assignments.length) return getBot(id);
  assignments.push('updated_at = ?');
  values.push(now(), id);
  run(`UPDATE bots SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  return getBot(id);
}

export function deleteBot(id) {
  run('DELETE FROM bots WHERE id = ?', id);
}

export function markScheduled(id) {
  const bot = get('SELECT schedule_on, schedule_cron FROM bots WHERE id = ?', id);
  if (!bot) return;
  run(
    'UPDATE bots SET next_run_at = ?, updated_at = ? WHERE id = ?',
    computeNextRun(Boolean(bot.schedule_on), bot.schedule_cron),
    now(),
    id,
  );
}

export function dueBots(at = new Date()) {
  return all(
    `SELECT * FROM bots
      WHERE enabled = 1 AND archived = 0 AND schedule_on = 1
        AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    at.toISOString(),
  ).map(toPublicBot);
}

/** Webhook tokens are shown exactly once, then only the digest is retained. */
export function rotateWebhookToken(id) {
  const token = randomToken(24);
  run(
    'UPDATE bots SET webhook_digest = ?, webhook_on = 1, updated_at = ? WHERE id = ?',
    tokenDigest(token),
    now(),
    id,
  );
  return token;
}

export function disableWebhook(id) {
  run(
    'UPDATE bots SET webhook_digest = ?, webhook_on = 0, updated_at = ? WHERE id = ?',
    '',
    now(),
    id,
  );
}

export function botForWebhook(id, token) {
  const row = get('SELECT * FROM bots WHERE id = ? AND webhook_on = 1', id);
  if (!row || !row.webhook_digest) return null;
  return row.webhook_digest === tokenDigest(token) ? toPublicBot(row) : null;
}

export function botMemories(botId) {
  return all('SELECT key, value, updated_at FROM memories WHERE bot_id = ? ORDER BY key', botId);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Starter teammates, so a fresh install has something to look at and edit
 * rather than an empty grid and a blank form.
 */
export const BOT_TEMPLATES = [
  {
    id: 'chief-of-staff',
    name: 'Chief of Staff',
    emoji: '\u{1F9ED}',
    color: '#f97316',
    job: 'Act as my chief of staff. Each morning, review what is on my plate, summarise what matters, and flag anything that needs a decision from me today.',
    context: 'Keep summaries short and scannable. Lead with anything time-sensitive.',
    boundaries: 'Never send messages on my behalf without approval. Never spend money.',
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall', 'web_search', 'fetch_page', 'write_file', 'read_file', 'list_files'],
    scheduleCron: '0 7 * * *',
    scheduleTask: 'Prepare my morning briefing.',
  },
  {
    id: 'research-analyst',
    name: 'Research Analyst',
    emoji: '\u{1F50E}',
    color: '#0ea5e9',
    job: 'Research topics I hand you and come back with a sourced, skimmable brief: what is true, what is contested, and what it means for me.',
    context: 'Always cite URLs. Separate fact from speculation. Say when evidence is thin.',
    boundaries: 'Do not run shell commands. Read-only web access only.',
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall', 'web_search', 'fetch_page', 'write_file', 'read_file', 'list_files'],
  },
  {
    id: 'inbox-triage',
    name: 'Inbox Triage',
    emoji: '\u{1F4EC}',
    color: '#8b5cf6',
    job: 'Triage my inbox through the connected mail tool: sort what needs a reply, what can wait, and what is noise. Draft replies for the urgent ones.',
    context: 'Match my usual tone: direct and friendly. Never more than a short paragraph.',
    boundaries: 'Draft only. Never send an email without explicit approval.',
    approvalPolicy: 'sensitive',
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall', 'write_file'],
    scheduleCron: '0 8 * * 1-5',
    scheduleTask: 'Triage anything that arrived overnight.',
  },
  {
    id: 'home-ops',
    name: 'Home Ops',
    emoji: '\u{1F3E1}',
    color: '#10b981',
    job: 'Look after the house: check device status through the connected smart-home tools, run the routines I ask for, and tell me when something looks wrong.',
    context: 'Report device name and room with every state change.',
    boundaries: 'Always ask before unlocking any door or disarming anything.',
    approvalPolicy: 'sensitive',
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall'],
  },
  {
    id: 'night-shift',
    name: 'Night Shift Engineer',
    emoji: '\u{1F6E0}',
    color: '#ef4444',
    job: 'Work through engineering chores on this machine overnight: run the checks I ask for, fix what is safe to fix, and leave me a report.',
    context: 'Show exact commands you ran and their output in the final report.',
    boundaries: 'Never touch anything outside the workspace folder. Never force-push.',
    approvalPolicy: 'sensitive',
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall', 'list_files', 'read_file', 'write_file', 'run_command'],
    shellDeny: ['rm -rf', 'git push --force', 'shutdown'],
  },
];

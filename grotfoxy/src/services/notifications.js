import { all, get, now, run, settings } from '../db/index.js';
import { newId } from '../core/crypto.js';
import bus from '../core/events.js';
import log from '../core/logger.js';

/**
 * Records a notification and, if an outbound webhook is configured, pushes it
 * off-box. The webhook shape is deliberately generic so it works with ntfy,
 * Discord, Slack, Home Assistant or a shell script behind a tiny listener.
 */
export async function notify({ title, body = '', level = 'info', botId = '', runId = '' }) {
  const id = newId('ntf');
  run(
    `INSERT INTO notifications (id, bot_id, run_id, level, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    botId,
    runId,
    level,
    String(title ?? '').slice(0, 300),
    String(body ?? '').slice(0, 4000),
    now(),
  );
  const record = get('SELECT * FROM notifications WHERE id = ?', id);
  bus.publish('notification', { notification: toPublic(record) });
  await pushWebhook({ title, body, level, botId, runId });
  return toPublic(record);
}

async function pushWebhook(payload) {
  const url = settings.get('notify.webhookUrl', '');
  if (!url) return;
  const format = settings.get('notify.webhookFormat', 'json');
  try {
    if (format === 'ntfy') {
      await fetch(url, {
        method: 'POST',
        headers: {
          Title: String(payload.title ?? 'GrotFoxy').slice(0, 200),
          Priority: payload.level === 'error' ? 'high' : 'default',
          Tags: 'fox',
        },
        body: String(payload.body ?? ''),
      });
      return;
    }
    if (format === 'slack' || format === 'discord') {
      const text = `*${payload.title}*\n${payload.body ?? ''}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(format === 'slack' ? { text } : { content: text }),
      });
      return;
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'grotfoxy', ...payload, at: now() }),
    });
  } catch (error) {
    log.warn(`notification webhook failed: ${error.message}`);
  }
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    botId: row.bot_id,
    runId: row.run_id,
    level: row.level,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function listNotifications({ limit = 50, unreadOnly = false } = {}) {
  const rows = unreadOnly
    ? all('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?', limit)
    : all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', limit);
  return rows.map(toPublic);
}

export function unreadCount() {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')?.n ?? 0;
}

export function markAllRead() {
  run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', now());
}

export function markRead(id) {
  run('UPDATE notifications SET read_at = ? WHERE id = ?', now(), id);
}

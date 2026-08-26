import { all, get, now, parseJson, run } from '../db/index.js';
import { newId } from '../core/crypto.js';
import bus from '../core/events.js';

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    botId: row.bot_id,
    kind: row.kind,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    args: parseJson(row.args, {}),
    reason: row.reason,
    status: row.status,
    note: row.note,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export function createApproval({ runId, botId, kind = 'approval', toolName, toolCallId, args, reason }) {
  const id = newId('apr');
  run(
    `INSERT INTO approvals (id, run_id, bot_id, kind, tool_name, tool_call_id, args, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    runId,
    botId,
    kind,
    toolName,
    toolCallId ?? '',
    JSON.stringify(args ?? {}),
    String(reason ?? ''),
    now(),
  );
  const record = toPublic(get('SELECT * FROM approvals WHERE id = ?', id));
  bus.publish('approval.created', { approval: record, runId, botId });
  return record;
}

export function getApproval(id) {
  return toPublic(get('SELECT * FROM approvals WHERE id = ?', id));
}

export function findForToolCall(runId, toolCallId) {
  return toPublic(
    get('SELECT * FROM approvals WHERE run_id = ? AND tool_call_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
      toolCallId),
  );
}

export function listPending() {
  return all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").map(toPublic);
}

export function pendingCount() {
  return get("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0;
}

export function listForRun(runId) {
  return all('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at', runId).map(toPublic);
}

/** `status` is 'approved', 'denied' or 'answered' (for ask_user questions). */
export function decideApproval(id, status, { note = '', decidedBy = 'owner' } = {}) {
  const existing = getApproval(id);
  if (!existing) return null;
  if (existing.status !== 'pending') return existing;
  run(
    'UPDATE approvals SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    status,
    String(note ?? ''),
    decidedBy,
    now(),
    id,
  );
  const record = getApproval(id);
  bus.publish('approval.decided', { approval: record, runId: record.runId, botId: record.botId });
  return record;
}

/** Called when a run ends so stale cards do not linger in the approvals queue. */
export function cancelPendingForRun(runId) {
  run(
    "UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE run_id = ? AND status = 'pending'",
    now(),
    runId,
  );
}

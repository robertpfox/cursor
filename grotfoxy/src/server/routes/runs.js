import { badRequest, notFound } from '../router.js';
import { requireAuth } from '../auth.js';
import { getBot } from '../../services/bots.js';
import { deleteRun, getRun, listRuns, listSteps, loadMessages, usageSummary } from '../../services/runs.js';
import { listForRun } from '../../services/approvals.js';
import { activeRunCount, cancelRun, queuedRunCount, startRun } from '../../runtime/runner.js';

export function registerRunRoutes(router) {
  router.get('/api/runs', (ctx) => {
    requireAuth(ctx);
    return listRuns({
      botId: ctx.query.botId,
      threadId: ctx.query.threadId,
      status: ctx.query.status,
      limit: Math.min(Number(ctx.query.limit) || 50, 200),
      offset: Number(ctx.query.offset) || 0,
    });
  });

  router.get('/api/runs/:id', (ctx) => {
    requireAuth(ctx);
    const record = getRun(ctx.params.id);
    if (!record) throw notFound('Run not found');
    const bot = getBot(record.botId);
    return {
      ...record,
      bot: bot ? { id: bot.id, name: bot.name, emoji: bot.emoji, color: bot.color } : null,
      steps: listSteps(record.id),
      approvals: listForRun(record.id),
    };
  });

  router.get('/api/runs/:id/transcript', (ctx) => {
    requireAuth(ctx);
    const record = getRun(ctx.params.id);
    if (!record) throw notFound('Run not found');
    return loadMessages(record.id);
  });

  router.post('/api/runs/:id/cancel', (ctx) => {
    requireAuth(ctx);
    const record = getRun(ctx.params.id);
    if (!record) throw notFound('Run not found');
    return { cancelled: cancelRun(record.id) };
  });

  router.post('/api/runs/:id/follow-up', (ctx) => {
    requireAuth(ctx);
    const previous = getRun(ctx.params.id);
    if (!previous) throw notFound('Run not found');
    const task = String(ctx.body.task ?? '').trim();
    if (!task) throw badRequest('Type a follow-up first.');
    // Same thread, new run: the bot keeps the conversation but starts a fresh
    // budget rather than inheriting a nearly-exhausted one.
    return startRun({
      botId: previous.botId,
      task,
      trigger: 'follow-up',
      threadId: previous.threadId,
      parentRunId: previous.id,
    });
  });

  router.delete('/api/runs/:id', (ctx) => {
    requireAuth(ctx);
    deleteRun(ctx.params.id);
    return { ok: true };
  });

  router.get('/api/usage', (ctx) => {
    requireAuth(ctx);
    return {
      ...usageSummary(Number(ctx.query.days) || 30),
      activeRuns: activeRunCount(),
      queuedRuns: queuedRunCount(),
    };
  });
}

export default registerRunRoutes;

import { HttpError } from '../router.js';
import { botForWebhook } from '../../services/bots.js';
import { startRun } from '../../runtime/runner.js';

/**
 * Unauthenticated-but-tokenised trigger URLs. This is how anything else on the
 * network kicks off a teammate: a Home Assistant automation, a GitHub webhook,
 * a Shortcut on your phone, a cron job on another box.
 */
export function registerWebhookRoutes(router) {
  const handler = (ctx) => {
    const bot = botForWebhook(ctx.params.id, ctx.params.token);
    if (!bot) throw new HttpError(404, 'No webhook matches that URL.');
    if (!bot.enabled) throw new HttpError(409, `${bot.name} is paused.`);

    const task =
      String(ctx.body?.task ?? '').trim() ||
      String(ctx.query.task ?? '').trim() ||
      bot.scheduleTask?.trim() ||
      'Run your job.';

    const payload = ctx.body && Object.keys(ctx.body).length ? ctx.body : null;
    const withPayload =
      payload && !payload.task
        ? `${task}\n\nWebhook payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2).slice(0, 8000)}\n\`\`\``
        : task;

    const record = startRun({ botId: bot.id, task: withPayload, trigger: 'webhook' });
    return { ok: true, runId: record.id, bot: bot.name };
  };

  router.post('/hooks/:id/:token', handler);
  router.get('/hooks/:id/:token', handler);
}

export default registerWebhookRoutes;

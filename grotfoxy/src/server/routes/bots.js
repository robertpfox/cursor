import { badRequest, notFound, requestOrigin } from '../router.js';
import { requireAuth } from '../auth.js';
import {
  BOT_TEMPLATES,
  botMemories,
  createBot,
  deleteBot,
  disableWebhook,
  getBot,
  listBots,
  rotateWebhookToken,
  updateBot,
} from '../../services/bots.js';
import { listRuns, listThreads } from '../../services/runs.js';
import { startRun } from '../../runtime/runner.js';
import { TOOL_GROUPS, toolCatalog } from '../../tools/index.js';
import { describeCron, isValidCron, nextCronDate } from '../../util/cron.js';

export function registerBotRoutes(router) {
  router.get('/api/bots', (ctx) => {
    requireAuth(ctx);
    const bots = listBots({ includeArchived: ctx.query.archived === '1' });
    return bots.map((bot) => ({
      ...bot,
      scheduleLabel: bot.scheduleOn ? describeCron(bot.scheduleCron) : '',
      recentRuns: listRuns({ botId: bot.id, limit: 5 }),
    }));
  });

  router.get('/api/bot-templates', (ctx) => {
    requireAuth(ctx);
    return BOT_TEMPLATES;
  });

  router.get('/api/tools', (ctx) => {
    requireAuth(ctx);
    return { groups: TOOL_GROUPS, tools: toolCatalog() };
  });

  router.post('/api/bots', (ctx) => {
    requireAuth(ctx);
    if (!ctx.body.name?.trim()) throw badRequest('Give your teammate a name.');
    if (ctx.body.scheduleCron && !isValidCron(ctx.body.scheduleCron)) {
      throw badRequest('That schedule is not a valid cron expression.');
    }
    return createBot(ctx.body);
  });

  router.get('/api/bots/:id', (ctx) => {
    requireAuth(ctx);
    const bot = getBot(ctx.params.id);
    if (!bot) throw notFound('Bot not found');
    return {
      ...bot,
      scheduleLabel: bot.scheduleOn ? describeCron(bot.scheduleCron) : '',
      memories: botMemories(bot.id),
      threads: listThreads(bot.id),
      runs: listRuns({ botId: bot.id, limit: 30 }),
    };
  });

  router.patch('/api/bots/:id', (ctx) => {
    requireAuth(ctx);
    if (ctx.body.scheduleCron && !isValidCron(ctx.body.scheduleCron)) {
      throw badRequest('That schedule is not a valid cron expression.');
    }
    const bot = updateBot(ctx.params.id, ctx.body);
    if (!bot) throw notFound('Bot not found');
    return bot;
  });

  router.delete('/api/bots/:id', (ctx) => {
    requireAuth(ctx);
    deleteBot(ctx.params.id);
    return { ok: true };
  });

  router.post('/api/bots/:id/run', (ctx) => {
    requireAuth(ctx);
    const bot = getBot(ctx.params.id);
    if (!bot) throw notFound('Bot not found');
    const task = String(ctx.body.task ?? '').trim();
    if (!task) throw badRequest('Describe the task you want done.');
    return startRun({
      botId: bot.id,
      task,
      trigger: 'manual',
      threadId: ctx.body.threadId ?? null,
      parentRunId: ctx.body.parentRunId ?? null,
    });
  });

  router.post('/api/bots/:id/webhook', (ctx) => {
    requireAuth(ctx);
    const bot = getBot(ctx.params.id);
    if (!bot) throw notFound('Bot not found');
    if (ctx.body.enabled === false) {
      disableWebhook(bot.id);
      return { enabled: false };
    }
    const token = rotateWebhookToken(bot.id);
    return {
      enabled: true,
      token,
      // Origin from the forwarded scheme, so a proxied install hands out an
      // https trigger URL rather than one that redirects or fails.
      url: `${requestOrigin(ctx.req)}/hooks/${bot.id}/${token}`,
    };
  });

  router.post('/api/cron/preview', (ctx) => {
    requireAuth(ctx);
    const expression = String(ctx.body.expression ?? '').trim();
    if (!isValidCron(expression)) return { valid: false, error: 'Not a valid 5-field cron expression.' };
    const upcoming = [];
    let cursor = new Date();
    for (let i = 0; i < 3; i += 1) {
      const next = nextCronDate(expression, cursor);
      if (!next) break;
      upcoming.push(next.toISOString());
      cursor = next;
    }
    return { valid: true, label: describeCron(expression), upcoming };
  });
}

export default registerBotRoutes;

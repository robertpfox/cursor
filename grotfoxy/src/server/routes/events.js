import bus from '../../core/events.js';
import { requireAuth } from '../auth.js';
import { pendingCount } from '../../services/approvals.js';
import { unreadCount } from '../../services/notifications.js';
import { activeRunCount, queuedRunCount } from '../../runtime/runner.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events keep every open dashboard and phone in sync with what the
 * bots are doing, without polling. One stream carries run steps, status
 * changes, approvals and notifications.
 */
export function registerEventRoutes(router) {
  router.get('/api/events', (ctx) => {
    requireAuth(ctx);
    const { res } = ctx;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event) => {
      if (res.writableEnded) return;
      res.write(`event: ${event.topic}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    send({
      topic: 'hello',
      at: new Date().toISOString(),
      counts: {
        approvals: pendingCount(),
        notifications: unreadCount(),
        activeRuns: activeRunCount(),
        queuedRuns: queuedRunCount(),
      },
    });

    const onEvent = (event) => send(event);
    bus.on('*', onEvent);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      bus.off('*', onEvent);
    };
    ctx.req.on('close', cleanup);
    ctx.req.on('error', cleanup);
    res.on('close', cleanup);
  });
}

export default registerEventRoutes;

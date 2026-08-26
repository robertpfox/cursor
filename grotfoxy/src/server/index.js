import http from 'node:http';
import config from '../config.js';
import log from '../core/logger.js';
import { Router, sendText, serveStatic } from './router.js';
import { attachUser } from './auth.js';
import registerAuthRoutes from './routes/auth.js';
import registerBotRoutes from './routes/bots.js';
import registerRunRoutes from './routes/runs.js';
import registerApprovalRoutes from './routes/approvals.js';
import registerSettingsRoutes from './routes/settings.js';
import registerEventRoutes from './routes/events.js';
import registerWebhookRoutes from './routes/webhooks.js';

export function buildRouter() {
  const router = new Router();
  router.use(attachUser);
  registerAuthRoutes(router);
  registerBotRoutes(router);
  registerRunRoutes(router);
  registerApprovalRoutes(router);
  registerSettingsRoutes(router);
  registerEventRoutes(router);
  registerWebhookRoutes(router);
  router.get('/healthz', () => ({ ok: true, version: config.version, uptime: process.uptime() }));
  return router;
}

export function createServer() {
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');

    try {
      const { handled } = await router.handle(req, res);
      if (handled) return;
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, config.publicDir);
        return;
      }
      sendText(res, 404, 'Not found');
    } catch (error) {
      log.error(`unhandled request error: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.end();
    }
  });
}

export function startServer() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export default startServer;

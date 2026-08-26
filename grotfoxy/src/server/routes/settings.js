import os from 'node:os';
import config from '../../config.js';
import { settings } from '../../db/index.js';
import { encryptSecret } from '../../core/crypto.js';
import { badRequest, notFound } from '../router.js';
import { requireAuth, setPassword } from '../auth.js';
import { PROVIDER_PRESETS } from '../../llm/index.js';
import {
  clearProviderKey,
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
} from '../../services/providers.js';
import {
  createConnector,
  deleteConnector,
  importFromMcpJson,
  listConnectors,
  testConnector,
  updateConnector,
} from '../../services/connectors.js';
import {
  listNotifications,
  markAllRead,
  markRead,
  notify,
  unreadCount,
} from '../../services/notifications.js';

const GENERAL_KEYS = [
  'general.ownerName',
  'general.timezone',
  'general.houseRules',
  'notify.webhookUrl',
  'notify.webhookFormat',
];

export function registerSettingsRoutes(router) {
  router.get('/api/settings', (ctx) => {
    requireAuth(ctx);
    const stored = settings.all();
    return {
      general: {
        ownerName: stored['general.ownerName'] ?? '',
        timezone: stored['general.timezone'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        houseRules: stored['general.houseRules'] ?? '',
      },
      notify: {
        webhookUrl: stored['notify.webhookUrl'] ?? '',
        webhookFormat: stored['notify.webhookFormat'] ?? 'json',
      },
      search: { hasBraveKey: Boolean(stored['search.braveKeyEnc']) },
      host: {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        dataDir: config.dataDir,
        workspaceDir: config.workspaceDir,
        port: config.port,
        bind: config.host,
        addresses: lanAddresses(),
        version: config.version,
      },
    };
  });

  router.patch('/api/settings', (ctx) => {
    requireAuth(ctx);
    for (const key of GENERAL_KEYS) {
      const [group, name] = key.split('.');
      const value = ctx.body?.[group]?.[name];
      if (value !== undefined) settings.set(key, value);
    }
    if (ctx.body?.search?.braveKey !== undefined) {
      settings.set(
        'search.braveKeyEnc',
        ctx.body.search.braveKey ? encryptSecret(ctx.body.search.braveKey) : '',
      );
    }
    return { ok: true };
  });

  router.post('/api/settings/password', (ctx) => {
    const user = requireAuth(ctx);
    setPassword(user.username, ctx.body.password);
    return { ok: true };
  });

  router.post('/api/settings/test-notification', async (ctx) => {
    requireAuth(ctx);
    await notify({
      title: 'GrotFoxy test notification',
      body: `Sent from ${os.hostname()} at ${new Date().toLocaleString()}.`,
      level: 'info',
    });
    return { ok: true };
  });

  router.get('/api/providers', (ctx) => {
    requireAuth(ctx);
    return { providers: listProviders(), presets: PROVIDER_PRESETS };
  });

  router.post('/api/providers', (ctx) => {
    requireAuth(ctx);
    if (!ctx.body.name?.trim()) throw badRequest('Name the provider.');
    return createProvider(ctx.body);
  });

  router.patch('/api/providers/:id', (ctx) => {
    requireAuth(ctx);
    const provider = updateProvider(ctx.params.id, ctx.body);
    if (!provider) throw notFound('Provider not found');
    return provider;
  });

  router.delete('/api/providers/:id', (ctx) => {
    requireAuth(ctx);
    deleteProvider(ctx.params.id);
    return { ok: true };
  });

  router.post('/api/providers/:id/clear-key', (ctx) => {
    requireAuth(ctx);
    return clearProviderKey(ctx.params.id);
  });

  router.post('/api/providers/:id/test', async (ctx) => {
    requireAuth(ctx);
    return testProvider(ctx.params.id);
  });

  router.get('/api/connectors', (ctx) => {
    requireAuth(ctx);
    return listConnectors();
  });

  router.post('/api/connectors', (ctx) => {
    requireAuth(ctx);
    if (!ctx.body.name?.trim()) throw badRequest('Name the connector.');
    return createConnector(ctx.body);
  });

  router.patch('/api/connectors/:id', (ctx) => {
    requireAuth(ctx);
    const connector = updateConnector(ctx.params.id, ctx.body);
    if (!connector) throw notFound('Connector not found');
    return connector;
  });

  router.delete('/api/connectors/:id', (ctx) => {
    requireAuth(ctx);
    deleteConnector(ctx.params.id);
    return { ok: true };
  });

  router.post('/api/connectors/:id/test', async (ctx) => {
    requireAuth(ctx);
    return testConnector(ctx.params.id);
  });

  router.post('/api/connectors/import', (ctx) => {
    requireAuth(ctx);
    const source = String(ctx.body.source ?? '').trim();
    if (!source) throw badRequest('Paste an mcp.json, or give the path to one.');
    try {
      return importFromMcpJson(source);
    } catch (error) {
      throw badRequest(`Could not import: ${error.message}`);
    }
  });

  router.get('/api/notifications', (ctx) => {
    requireAuth(ctx);
    return {
      unread: unreadCount(),
      items: listNotifications({ limit: Math.min(Number(ctx.query.limit) || 50, 200) }),
    };
  });

  router.post('/api/notifications/read', (ctx) => {
    requireAuth(ctx);
    if (ctx.body.id) markRead(ctx.body.id);
    else markAllRead();
    return { unread: unreadCount() };
  });
}

/** Addresses a phone on the same network can actually reach. */
function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export default registerSettingsRoutes;

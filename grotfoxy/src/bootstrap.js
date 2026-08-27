import os from 'node:os';
import { openDatabase, settings } from './db/index.js';
import { listProviders, createProvider } from './services/providers.js';
import log from './core/logger.js';

/**
 * First-boot defaults. A brand new instance should be usable the moment a local
 * model server is running, without the owner filling in a settings form first.
 */
export function bootstrap() {
  openDatabase();

  if (settings.get('general.timezone', null) === null) {
    settings.set('general.timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  if (settings.get('general.houseRules', null) === null) {
    settings.set(
      'general.houseRules',
      'Be concise. Lead with the outcome, then the detail.\nNever spend money without approval.\nIf you are unsure, say so instead of guessing.',
    );
  }
  if (settings.get('notify.webhookFormat', null) === null) {
    settings.set('notify.webhookFormat', 'json');
  }

  if (!listProviders().length) {
    createProvider({
      name: 'Ollama (local)',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'qwen2.5:7b',
      enabled: true,
    });
    log.info('seeded a local Ollama provider; edit it in Settings \u2192 Models');
  }

  if (settings.get('general.installedAt', null) === null) {
    settings.set('general.installedAt', new Date().toISOString());
    settings.set('general.installedOn', os.hostname());
  }
}

export default bootstrap;

import { all, get, now, run, settings } from '../db/index.js';
import { newId } from '../core/crypto.js';
import { notify } from '../services/notifications.js';

/**
 * Long-term memory. Anything a bot learns that should outlive one run goes
 * here, and every stored key is injected into its next system prompt.
 */
export const memoryTools = [
  {
    name: 'remember',
    group: 'memory',
    sensitivity: 'safe',
    description: 'Save a fact to long-term memory so future runs of this bot can see it.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short identifier, e.g. "preferred_report_format".' },
        value: { type: 'string', description: 'The fact to remember.' },
      },
      required: ['key', 'value'],
    },
    async execute({ key, value }, ctx) {
      const timestamp = now();
      run(
        `INSERT INTO memories (id, bot_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        newId('mem'),
        ctx.bot.id,
        String(key).slice(0, 120),
        String(value).slice(0, 4000),
        timestamp,
        timestamp,
      );
      return { output: `Remembered "${key}".` };
    },
  },
  {
    name: 'recall',
    group: 'memory',
    sensitivity: 'safe',
    description: 'Look up one remembered fact, or list every remembered key.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Omit to list all memories.' } },
    },
    async execute({ key }, ctx) {
      if (key) {
        const row = get('SELECT value FROM memories WHERE bot_id = ? AND key = ?', ctx.bot.id, key);
        return { output: row ? row.value : `Nothing remembered under "${key}".` };
      }
      const rows = all('SELECT key, value FROM memories WHERE bot_id = ? ORDER BY key', ctx.bot.id);
      if (!rows.length) return { output: 'No memories stored yet.' };
      return { output: rows.map((row) => `${row.key}: ${row.value}`).join('\n') };
    },
  },
  {
    name: 'forget',
    group: 'memory',
    sensitivity: 'safe',
    description: 'Delete one remembered fact.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    async execute({ key }, ctx) {
      run('DELETE FROM memories WHERE bot_id = ? AND key = ?', ctx.bot.id, key);
      return { output: `Forgot "${key}".` };
    },
  },
];

export const notifyTools = [
  {
    name: 'notify_user',
    group: 'notify',
    sensitivity: 'safe',
    description:
      'Send the owner a notification (in-app plus any configured push webhook). Use for anything worth interrupting them about.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
      },
      required: ['title'],
    },
    async execute({ title, body, level = 'info' }, ctx) {
      await notify({ title, body, level, botId: ctx.bot.id, runId: ctx.run.id });
      return { output: `Notification sent: ${title}` };
    },
  },
];

export const timeTools = [
  {
    name: 'get_current_time',
    group: 'core',
    sensitivity: 'safe',
    description: 'Get the current date and time on the host machine.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const timeZone = settings.get('general.timezone', '') || undefined;
      const date = new Date();
      return {
        output: [
          `ISO (UTC): ${date.toISOString()}`,
          `Local: ${date.toLocaleString('en-US', timeZone ? { timeZone } : undefined)}`,
          `Timezone: ${timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        ].join('\n'),
      };
    },
  },
];

/**
 * Lets a run pause for a human answer instead of guessing. The runtime turns
 * this into an approval-style prompt in the UI.
 */
export const askTools = [
  {
    name: 'ask_user',
    group: 'core',
    sensitivity: 'ask',
    description:
      'Pause and ask the owner a question. Only use it when you genuinely cannot proceed without their answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' },
      },
      required: ['question'],
    },
    async execute() {
      // The runtime intercepts this tool before execution; reaching the body
      // would mean the interception path was bypassed.
      throw new Error('ask_user is handled by the runtime');
    },
  },
];

export const builtinTools = [...memoryTools, ...notifyTools, ...timeTools, ...askTools];

export default builtinTools;

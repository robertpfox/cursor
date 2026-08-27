import config from '../config.js';
import log from '../core/logger.js';
import { dueBots, markScheduled } from '../services/bots.js';
import { startRun } from './runner.js';

const TICK_MS = 20_000;
let timer = null;

export function tick(at = new Date()) {
  const due = dueBots(at);
  for (const bot of due) {
    // Advance the schedule before starting work, so a long run can never cause
    // the same slot to fire twice.
    markScheduled(bot.id);
    try {
      const record = startRun({
        botId: bot.id,
        task: bot.scheduleTask?.trim() || 'Run your scheduled job.',
        trigger: 'schedule',
      });
      log.info(`scheduled run ${record.id} for "${bot.name}"`);
    } catch (error) {
      log.warn(`could not start scheduled run for "${bot.name}": ${error.message}`);
    }
  }
  return due.length;
}

export function startScheduler() {
  if (!config.schedulerEnabled || timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      log.error(`scheduler tick failed: ${error.message}`);
    }
  }, TICK_MS);
  timer.unref?.();
  log.info(`scheduler running (every ${TICK_MS / 1000}s)`);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

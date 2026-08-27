import config from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, stream, args) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  stream(`${stamp} ${level.toUpperCase().padEnd(5)} ${args.map(format).join(' ')}`);
}

function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args) => emit('debug', console.log, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
};

export default log;

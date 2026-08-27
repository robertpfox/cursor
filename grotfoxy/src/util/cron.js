/**
 * Small 5-field cron parser (minute hour day-of-month month day-of-week).
 * Supports `*`, `*&#47;n`, `a,b`, `a-b` and `a-b/n`, plus the common `@hourly`
 * style shorthands. That covers every schedule a home automation actually needs
 * without pulling in a dependency.
 */

const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function fieldToken(token, index) {
  const lower = String(token).toLowerCase();
  if (index === 3) {
    const month = MONTH_NAMES.indexOf(lower);
    if (month !== -1) return month + 1;
  }
  if (index === 4) {
    const day = DAY_NAMES.indexOf(lower);
    if (day !== -1) return day;
  }
  const parsed = Number.parseInt(lower, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid cron value "${token}"`);
  return parsed;
}

function parseField(field, index) {
  const { min, max } = RANGES[index];
  const values = new Set();

  for (const part of String(field).split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`Invalid cron step in "${part}"`);

    let from;
    let to;
    if (rangePart === '*' || rangePart === '?') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      from = fieldToken(a, index);
      to = fieldToken(b, index);
    } else {
      from = fieldToken(rangePart, index);
      to = stepPart ? max : from;
    }

    if (index === 4 && from === 7) from = 0;
    if (index === 4 && to === 7) to = 0;
    if (from < min || to > max || from > to) {
      throw new Error(`Cron value out of range in "${part}" (expected ${min}-${max})`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (!values.size) throw new Error(`Cron field "${field}" matches nothing`);
  return values;
}

export function parseCron(expression) {
  const text = String(expression ?? '').trim().toLowerCase();
  if (!text) throw new Error('Cron expression is empty');
  const normalized = ALIASES[text] ?? text;
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have 5 fields: minute hour day month weekday');
  }
  return {
    minute: parseField(fields[0], 0),
    hour: parseField(fields[1], 1),
    dayOfMonth: parseField(fields[2], 2),
    month: parseField(fields[3], 3),
    dayOfWeek: parseField(fields[4], 4),
    // Cron's historical rule: when both day fields are restricted, either can
    // match; when only one is, it alone gates the schedule.
    domRestricted: fields[2] !== '*' && fields[2] !== '?',
    dowRestricted: fields[4] !== '*' && fields[4] !== '?',
  };
}

export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function nextCronDate(expression, from = new Date()) {
  const cron = parseCron(expression);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Four years of minutes is a safe upper bound that still terminates on
  // impossible dates such as "Feb 30".
  const limit = 366 * 4 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    if (matches(cron, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function matches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;

  const domMatch = cron.dayOfMonth.has(date.getDate());
  const dowMatch = cron.dayOfWeek.has(date.getDay());
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  if (cron.domRestricted) return domMatch;
  if (cron.dowRestricted) return dowMatch;
  return true;
}

export function describeCron(expression) {
  const presets = {
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Every hour, on the hour',
    '0 7 * * *': 'Every day at 7:00 AM',
    '0 8 * * *': 'Every day at 8:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 18 * * *': 'Every day at 6:00 PM',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
  };
  const text = String(expression ?? '').trim();
  if (presets[text]) return presets[text];
  try {
    const next = nextCronDate(text);
    return next ? `Next run ${next.toLocaleString()}` : text;
  } catch {
    return 'Invalid schedule';
  }
}

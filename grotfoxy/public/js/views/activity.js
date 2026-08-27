import api from '../api.js';
import { compactNumber, h, money, mount, plural, relTime } from '../dom.js';
import { avatar, empty, statusPill, toast } from '../ui.js';
import { navigate } from '../router.js';
import store from '../store.js';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Working' },
  { value: 'awaiting_approval', label: 'Blocked' },
  { value: 'succeeded', label: 'Done' },
  { value: 'failed', label: 'Failed' },
];

export async function renderActivity(root, { status = '' } = {}) {
  const [runs, bots, usage] = await Promise.all([
    api.get(`/api/runs?limit=100${status ? `&status=${status}` : ''}`),
    api.get('/api/bots'),
    api.get('/api/usage?days=30'),
  ]);

  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const filters = h(
    'div',
    { class: 'chips' },
    ...FILTERS.map((filter) =>
      h(
        'button',
        {
          type: 'button',
          class: `chip${filter.value === status ? ' is-on' : ''}`,
          onclick: () => renderActivity(root, { status: filter.value }),
        },
        filter.label,
      ),
    ),
  );

  // Always plot the full window. Charting only the days that have rows makes
  // two busy days fill the whole card and reads as though that is the trend.
  const byDay = new Map(usage.byDay.map((entry) => [entry.day, entry]));
  const series = [];
  for (const cursor = new Date(`${usage.since}T00:00:00Z`); ; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10);
    series.push(byDay.get(day) ?? { day, runs: 0, cost_usd: 0 });
    if (day >= new Date().toISOString().slice(0, 10)) break;
  }
  const busiest = Math.max(...series.map((entry) => entry.runs || 0), 1);

  const spendChart = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', 'Last 30 days'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'tiny muted' }, `${money(usage.totals.cost_usd)} of model usage · $0 in subscription fees`),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '70px' } },
      ...series.map((day) =>
        h('div', {
          title: `${day.day}: ${plural(day.runs || 0, 'run')}, ${money(day.cost_usd)}`,
          style: {
            flex: '1 1 0',
            minWidth: '0',
            height: `${Math.max(3, Math.round(((day.runs || 0) / busiest) * 64))}px`,
            borderRadius: '2px',
            background: day.runs ? 'linear-gradient(180deg, #fb923c, #ea6a0a)' : 'var(--line-soft)',
          },
        }),
      ),
    ),
    h(
      'div',
      { class: 'row tiny muted', style: { marginTop: '8px' } },
      h('span', series[0].day),
      h('span', { class: 'spacer' }),
      h('span', `${compactNumber(usage.totals.tokens_in)} in`),
      h('span', `${compactNumber(usage.totals.tokens_out)} out`),
      h('span', plural(usage.totals.runs, 'completed run')),
    ),
  );

  mount(
    root,
    h(
      'div',
      { class: 'view__inner' },
      spendChart,
      filters,
      runs.length
        ? h(
            'div',
            { class: 'list' },
            ...runs.map((entry) => {
              const bot = byId.get(entry.botId);
              return h(
                'button',
                { type: 'button', class: 'list__item', onclick: () => navigate(`/runs/${entry.id}`) },
                avatar(bot ?? { name: '?' }, true),
                h(
                  'div',
                  { class: 'list__main' },
                  h('div', { class: 'list__title' }, entry.task || '(scheduled job)'),
                  h(
                    'div',
                    { class: 'list__sub' },
                    `${bot?.name ?? 'Unknown'} · ${entry.trigger} · ${relTime(entry.createdAt)} · ${entry.stepsUsed} steps · ${money(entry.costUsd)}`,
                  ),
                ),
                statusPill(entry.status),
              );
            }),
          )
        : empty('Nothing here yet', 'Runs appear as your teammates work.'),
    ),
  );
}

export function watchActivity(root) {
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      renderActivity(root).catch((error) => toast(error.message, 'error'));
    }, 500);
  };
  const offs = [store.on('run.created', refresh), store.on('run.finished', refresh)];
  return () => offs.forEach((off) => off());
}

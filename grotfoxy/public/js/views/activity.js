import api from '../api.js';
import { compactNumber, h, money, mount, relTime } from '../dom.js';
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

  const spendChart = usage.byDay.length
    ? h(
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
          { class: 'row', style: { alignItems: 'flex-end', gap: '3px', height: '70px' } },
          ...usage.byDay.map((day) => {
            const max = Math.max(...usage.byDay.map((entry) => entry.runs || 0), 1);
            const height = Math.max(4, Math.round(((day.runs || 0) / max) * 64));
            return h('div', {
              title: `${day.day}: ${day.runs} runs, ${money(day.cost_usd)}`,
              style: {
                flex: '1',
                minWidth: '4px',
                height: `${height}px`,
                borderRadius: '3px',
                background: day.runs ? 'linear-gradient(180deg, #fb923c, #ea6a0a)' : 'var(--line)',
              },
            });
          }),
        ),
        h(
          'div',
          { class: 'row tiny muted', style: { marginTop: '8px' } },
          h('span', `${compactNumber(usage.totals.tokens_in)} in`),
          h('span', `${compactNumber(usage.totals.tokens_out)} out`),
          h('span', { class: 'spacer' }),
          h('span', `${usage.totals.runs} completed runs`),
        ),
      )
    : null;

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

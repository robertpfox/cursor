import api from '../api.js';
import { compactNumber, h, icon, money, mount, relTime } from '../dom.js';
import { avatar, empty, statusPill, toast } from '../ui.js';
import { openBotEditor, openTemplatePicker } from '../components/boteditor.js';
import store from '../store.js';
import { navigate } from '../router.js';
import { approvalCard } from './approvals.js';

function stat(label, value, foot, accent = false) {
  return h(
    'div',
    { class: `stat${accent ? ' stat--accent' : ''}` },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value' }, value),
    foot ? h('span', { class: 'stat__foot' }, foot) : null,
  );
}

function botCard(bot) {
  const sparks = h(
    'div',
    { class: 'sparks', title: 'Recent runs, newest first' },
    ...[...(bot.recentRuns ?? [])].map((entry) => h('span', { class: `spark spark--${entry.status}` })),
    ...Array.from({ length: Math.max(0, 5 - (bot.recentRuns?.length ?? 0)) }, () => h('span', { class: 'spark' })),
  );

  const last = bot.recentRuns?.[0];

  return h(
    'button',
    { type: 'button', class: 'botcard', onclick: () => navigate(`/bots/${bot.id}`) },
    h(
      'div',
      { class: 'botcard__top' },
      avatar(bot),
      h(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'botcard__name' }, bot.name),
        h('div', { class: 'botcard__job' }, bot.job || 'No job description yet.'),
      ),
      !bot.enabled ? h('span', { class: 'tag' }, 'paused') : null,
    ),
    h(
      'div',
      { class: 'botcard__meta' },
      sparks,
      last ? statusPill(last.status) : h('span', { class: 'tiny muted' }, 'never run'),
      h('span', { class: 'spacer' }),
      bot.scheduleOn ? h('span', { class: 'tag' }, bot.scheduleLabel || 'scheduled') : null,
      last ? h('span', relTime(last.createdAt)) : null,
    ),
  );
}

export async function renderDashboard(root) {
  const [bots, usage, approvals, runs] = await Promise.all([
    api.get('/api/bots'),
    api.get('/api/usage?days=30'),
    api.get('/api/approvals'),
    api.get('/api/runs?limit=8'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const todayUsage = usage.byDay.find((entry) => entry.day === today);
  const activeToday = runs.filter((entry) => entry.createdAt.slice(0, 10) === today).length;

  const statsRow = h(
    'div',
    { class: 'grid grid--stats' },
    stat('Teammates', String(bots.length), `${bots.filter((bot) => bot.scheduleOn).length} on a schedule`),
    stat(
      'Runs today',
      String(activeToday),
      usage.activeRuns ? `${usage.activeRuns} working now` : 'idle',
    ),
    stat(
      'Waiting on you',
      String(approvals.length),
      approvals.length ? 'review below' : 'nothing blocked',
    ),
    stat(
      'Spend (30 days)',
      money(usage.totals.cost_usd),
      `${compactNumber((usage.totals.tokens_in ?? 0) + (usage.totals.tokens_out ?? 0))} tokens · $0/mo subscription`,
      true,
    ),
  );

  const approvalsSection = approvals.length
    ? h(
        'section',
        { class: 'stack' },
        h(
          'div',
          { class: 'row' },
          h('h2', { style: { fontSize: '15px' } }, `${approvals.length} thing${approvals.length === 1 ? '' : 's'} need you`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => navigate('/approvals') }, 'See all'),
        ),
        ...approvals.slice(0, 3).map((approval) => approvalCard(approval, () => renderDashboard(root))),
      )
    : null;

  const botsSection = h(
    'section',
    { class: 'stack' },
    h(
      'div',
      { class: 'row' },
      h('h2', { style: { fontSize: '15px' } }, 'Your teammates'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: async () => {
            const created = await openTemplatePicker();
            if (created) renderDashboard(root);
          },
        },
        'From template',
      ),
      h(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          type: 'button',
          onclick: async () => {
            const created = await openBotEditor();
            if (created) navigate(`/bots/${created.id}`);
          },
        },
        icon('plus'),
        'New teammate',
      ),
    ),
    bots.length
      ? h('div', { class: 'grid grid--bots' }, ...bots.map(botCard))
      : empty(
          'No teammates yet',
          'Create one from a template to see how it works, or start from scratch.',
          h(
            'div',
            { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
            h(
              'button',
              {
                class: 'btn btn--primary',
                type: 'button',
                onclick: async () => {
                  const created = await openTemplatePicker();
                  if (created) renderDashboard(root);
                },
              },
              'Browse templates',
            ),
          ),
        ),
  );

  const activitySection = runs.length
    ? h(
        'section',
        { class: 'stack' },
        h(
          'div',
          { class: 'row' },
          h('h2', { style: { fontSize: '15px' } }, 'Recent activity'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => navigate('/activity') }, 'Full history'),
        ),
        h(
          'div',
          { class: 'list' },
          ...runs.map((entry) => {
            const bot = bots.find((item) => item.id === entry.botId);
            return h(
              'button',
              { type: 'button', class: 'list__item', onclick: () => navigate(`/runs/${entry.id}`) },
              avatar(bot ?? { name: '?' }, true),
              h(
                'div',
                { class: 'list__main' },
                h('div', { class: 'list__title' }, entry.task || '(scheduled job)'),
                h('div', { class: 'list__sub' }, `${bot?.name ?? 'Unknown'} · ${entry.trigger} · ${relTime(entry.createdAt)}`),
              ),
              statusPill(entry.status),
            );
          }),
        ),
      )
    : null;

  mount(
    root,
    h(
      'div',
      { class: 'view__inner' },
      statsRow,
      approvalsSection,
      botsSection,
      activitySection,
    ),
  );
}

/** Re-render on any run or approval activity so the dashboard is always current. */
export function watchDashboard(root) {
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      renderDashboard(root).catch((error) => toast(error.message, 'error'));
    }, 350);
  };
  const offs = [
    store.on('run.created', refresh),
    store.on('run.finished', refresh),
    store.on('approval.created', refresh),
    store.on('approval.decided', refresh),
  ];
  return () => offs.forEach((off) => off());
}

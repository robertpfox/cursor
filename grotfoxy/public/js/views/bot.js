import api from '../api.js';
import { h, icon, money, mount, relTime } from '../dom.js';
import { attachDictation, avatar, confirmDialog, copyToClipboard, empty, statusPill, toast } from '../ui.js';
import { openBotEditor } from '../components/boteditor.js';
import { navigate } from '../router.js';
import store from '../store.js';

function summaryRow(label, value) {
  return h(
    'div',
    { class: 'row', style: { gap: '10px', alignItems: 'baseline' } },
    h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, label),
    h('span', { class: 'small', style: { flex: '1', minWidth: '0' } }, value),
  );
}

export async function renderBot(root, botId) {
  const bot = await api.get(`/api/bots/${botId}`);
  const refresh = () => renderBot(root, botId).catch((error) => toast(error.message, 'error'));

  const task = h('textarea', {
    placeholder: `Give ${bot.name} something to do. Describe the outcome you want, not the steps.`,
    rows: 3,
    'aria-label': `Task for ${bot.name}`,
  });
  const micBtn = h('button', { class: 'iconbtn mic', type: 'button', 'aria-label': 'Dictate' }, icon('mic'));
  attachDictation(micBtn, task);

  const send = async () => {
    const text = task.value.trim();
    if (!text) {
      toast('Describe the task first.', 'error');
      return;
    }
    try {
      const record = await api.post(`/api/bots/${bot.id}/run`, { task: text });
      navigate(`/runs/${record.id}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  task.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send();
  });

  const composer = h(
    'div',
    { class: 'composer' },
    task,
    h(
      'div',
      { class: 'composer__bar' },
      micBtn,
      h('span', { class: 'tiny muted' }, 'Cmd/Ctrl + Enter'),
      h('span', { class: 'spacer' }),
      bot.scheduleOn
        ? h(
            'button',
            {
              class: 'btn btn--sm',
              type: 'button',
              title: 'Run the scheduled job right now',
              onclick: async () => {
                const record = await api.post(`/api/bots/${bot.id}/run`, {
                  task: bot.scheduleTask || 'Run your scheduled job.',
                });
                navigate(`/runs/${record.id}`);
              },
            },
            'Run scheduled job',
          )
        : null,
      h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: send }, icon('play'), 'Start work'),
    ),
  );

  const runsList = bot.runs.length
    ? h(
        'div',
        { class: 'list' },
        ...bot.runs.map((entry) =>
          h(
            'button',
            { type: 'button', class: 'list__item', onclick: () => navigate(`/runs/${entry.id}`) },
            h(
              'div',
              { class: 'list__main' },
              h('div', { class: 'list__title' }, entry.task || '(scheduled job)'),
              h(
                'div',
                { class: 'list__sub' },
                `${entry.trigger} · ${relTime(entry.createdAt)} · ${entry.stepsUsed} steps · ${money(entry.costUsd)}`,
              ),
            ),
            statusPill(entry.status),
          ),
        ),
      )
    : empty('No runs yet', 'Give this teammate a task above and it will get to work.');

  const setup = h(
    'div',
    { class: 'card stack' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', 'Setup'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            const saved = await openBotEditor(bot);
            if (saved) refresh();
          },
        },
        'Edit',
      ),
    ),
    summaryRow('Job', bot.job || '—'),
    summaryRow('Context', bot.context || '—'),
    summaryRow('Boundaries', bot.boundaries || '—'),
    summaryRow('Model', `${bot.model || 'not set'} · temp ${bot.temperature}`),
    summaryRow('Approvals', {
      never: 'Full autonomy — never asks',
      sensitive: 'Asks before sensitive actions',
      always: 'Asks before every tool',
    }[bot.approvalPolicy] ?? bot.approvalPolicy),
    summaryRow('Tool calls', bot.parallelTools ? 'Several per turn allowed' : 'One at a time'),
    summaryRow('Limits', `${bot.maxSteps} steps · ${bot.maxSeconds}s · ${money(bot.maxCostUsd)} per run`),
    summaryRow('Schedule', bot.scheduleOn ? `${bot.scheduleLabel} — ${bot.scheduleTask || 'no task set'}` : 'Off'),
    summaryRow(
      'Tools',
      h('div', { class: 'chips' }, ...bot.tools.map((name) => h('span', { class: 'chip is-on' }, name))),
    ),
  );

  const webhookBtn = h(
    'button',
    {
      class: 'btn btn--sm',
      type: 'button',
      onclick: async () => {
        const result = await api.post(`/api/bots/${bot.id}/webhook`, { enabled: true });
        await navigator.clipboard?.writeText(result.url).catch(() => {});
        toast('Trigger URL copied. It is shown once.', 'success');
        webhookOut.textContent = result.url;
        webhookOut.hidden = false;
      },
    },
    bot.hasWebhookToken ? 'Regenerate trigger URL' : 'Create trigger URL',
  );
  const webhookOut = h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } });
  webhookOut.hidden = true;

  const triggers = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'Triggers')),
    h(
      'p',
      { class: 'small muted', style: { margin: 0 } },
      'Anything on your network can start this teammate: a Home Assistant automation, a phone shortcut, a GitHub webhook, another machine\u2019s cron.',
    ),
    h('div', { class: 'row' }, webhookBtn, bot.hasWebhookToken ? h('span', { class: 'tag' }, 'active') : null),
    webhookOut,
  );

  const memories = bot.memories.length
    ? h(
        'div',
        { class: 'list' },
        ...bot.memories.map((entry) =>
          h(
            'div',
            { class: 'list__item is-static' },
            h(
              'div',
              { class: 'list__main' },
              h('div', { class: 'list__title' }, entry.key),
              h('div', { class: 'list__sub' }, entry.value),
            ),
            h('span', { class: 'tiny muted nowrap' }, relTime(entry.updated_at)),
          ),
        ),
      )
    : h('p', { class: 'small muted', style: { margin: 0 } }, 'Nothing remembered yet. This teammate saves facts here as it learns them.');

  const danger = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'Manage')),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            await api.patch(`/api/bots/${bot.id}`, { enabled: !bot.enabled });
            toast(bot.enabled ? `${bot.name} paused` : `${bot.name} is back on`, 'success');
            refresh();
          },
        },
        bot.enabled ? 'Pause teammate' : 'Resume teammate',
      ),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: () => copyToClipboard(JSON.stringify(bot, null, 2)),
        },
        icon('copy'),
        'Copy config',
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          onclick: async () => {
            const yes = await confirmDialog({
              title: `Delete ${bot.name}?`,
              message: 'Their runs, transcripts and memories go with them. This cannot be undone.',
              confirmLabel: 'Delete permanently',
            });
            if (!yes) return;
            await api.del(`/api/bots/${bot.id}`);
            toast('Teammate deleted');
            navigate('/');
          },
        },
        icon('trash'),
        'Delete',
      ),
    ),
  );

  mount(
    root,
    h(
      'div',
      { class: 'view__inner' },
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'iconbtn', type: 'button', onclick: () => navigate('/'), 'aria-label': 'Back' }, icon('back')),
        avatar(bot),
        h(
          'div',
          { style: { flex: '1', minWidth: '0' } },
          h('h2', { style: { fontSize: '18px' } }, bot.name),
          h('div', { class: 'tiny muted' }, bot.enabled ? 'Ready for work' : 'Paused'),
        ),
      ),
      composer,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', 'Runs'), h('span', { class: 'spacer' }), h('span', { class: 'tiny muted' }, `${bot.runs.length} recent`)),
        runsList,
      ),
      setup,
      triggers,
      h('div', { class: 'card stack' }, h('div', { class: 'card__head' }, h('h3', 'Memory')), memories),
      danger,
    ),
  );
}

export function watchBot(root, botId) {
  let queued = false;
  const refresh = (payload) => {
    if (payload.botId && payload.botId !== botId) return;
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      renderBot(root, botId).catch(() => {});
    }, 400);
  };
  const offs = [store.on('run.created', refresh), store.on('run.finished', refresh)];
  return () => offs.forEach((off) => off());
}

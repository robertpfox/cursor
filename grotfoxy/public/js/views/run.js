import api from '../api.js';
import { clockTime, duration, h, icon, money, mount, plural, relTime } from '../dom.js';
import { attachDictation, avatar, statusPill, toast } from '../ui.js';
import { navigate } from '../router.js';
import store from '../store.js';
import { approvalCard } from './approvals.js';

const STEP_ICONS = {
  status: 'flag',
  thinking: 'brain',
  tool: 'tool',
  approval: 'shield',
  question: 'question',
  answer: 'check',
  error: 'alert',
  warning: 'alert',
  result: 'check',
};

function parseDetail(detail) {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    return typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function block(label, text) {
  return h('div', h('div', { class: 'lbl' }, label), h('pre', text));
}

function stepNode(step) {
  const parsed = step.kind === 'tool' ? parseDetail(step.detail) : null;

  let body = null;
  if (parsed) {
    const args = JSON.stringify(parsed.args ?? {}, null, 2);
    const io = h(
      'div',
      { class: 'tl__io' },
      args && args !== '{}' ? block('input', args) : null,
      parsed.error ? block('error', parsed.error) : null,
      parsed.output !== undefined && parsed.output !== '' ? block('output', parsed.output) : null,
    );
    // Tool payloads are long; keep the timeline scannable and let the reader
    // open the ones they care about.
    body = h(
      'details',
      { class: 'disclose', open: Boolean(parsed.error) },
      h('summary', parsed.error ? 'Show error' : 'Show input and output'),
      io,
    );
  } else if (step.detail) {
    body = h('div', { class: 'tl__text' }, step.detail);
  }

  return h(
    'div',
    { class: `tl tl--${step.kind}${step.status === 'error' ? ' tl--error' : ''}`, dataset: { seq: step.seq } },
    h('div', { class: 'tl__dot' }, icon(STEP_ICONS[step.kind] ?? 'dot')),
    h(
      'div',
      { class: 'tl__body' },
      h(
        'div',
        { class: 'tl__title' },
        step.title,
        h('span', { class: 'tl__time' }, clockTime(step.createdAt)),
        step.durationMs ? h('span', { class: 'tl__time' }, duration(step.durationMs)) : null,
      ),
      body,
    ),
  );
}

export async function renderRun(root, runId) {
  const record = await api.get(`/api/runs/${runId}`);
  const refresh = () => renderRun(root, runId).catch((error) => toast(error.message, 'error'));

  const timeline = h('div', { class: 'timeline' }, ...record.steps.map(stepNode));
  const pending = record.approvals.filter((entry) => entry.status === 'pending');

  const isLive = ['queued', 'running'].includes(record.status);
  const isDone = ['succeeded', 'failed', 'cancelled', 'incomplete'].includes(record.status);

  const resultCard = isDone
    ? h(
        'div',
        {
          class: `result${record.status === 'succeeded' ? '' : record.status === 'incomplete' ? ' result--warn' : ' result--bad'}`,
        },
        h(
          'div',
          { class: 'row', style: { marginBottom: '8px' } },
          h('h3', { style: { fontSize: '14px' } }, record.status === 'succeeded' ? 'Result' : 'Outcome'),
          h('span', { class: 'spacer' }),
          statusPill(record.status),
        ),
        h('div', { class: 'prose' }, record.result || record.error || '(no output)'),
        record.result && record.error ? h('p', { class: 'small muted', style: { marginTop: '10px', marginBottom: 0 } }, record.error) : null,
      )
    : null;

  const followUp = h('textarea', {
    placeholder: `Reply to ${record.bot?.name ?? 'this teammate'} — it keeps the whole conversation.`,
    rows: 2,
  });
  const micBtn = h('button', { class: 'iconbtn mic', type: 'button', 'aria-label': 'Dictate' }, icon('mic'));
  attachDictation(micBtn, followUp);

  const sendFollowUp = async () => {
    const task = followUp.value.trim();
    if (!task) return;
    try {
      const next = await api.post(`/api/runs/${runId}/follow-up`, { task });
      navigate(`/runs/${next.id}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  followUp.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendFollowUp();
  });

  const composer = isDone
    ? h(
        'div',
        { class: 'composer' },
        followUp,
        h(
          'div',
          { class: 'composer__bar' },
          micBtn,
          h('span', { class: 'tiny muted' }, 'Cmd/Ctrl + Enter to send'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: sendFollowUp }, icon('send'), 'Send'),
        ),
      )
    : null;

  const header = h(
    'div',
    { class: 'card card--tight' },
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'iconbtn', type: 'button', onclick: () => navigate(`/bots/${record.botId}`), 'aria-label': 'Back to bot' }, icon('back')),
      avatar(record.bot ?? { name: '?' }, true),
      h(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { fontWeight: '600' } }, record.bot?.name ?? 'Unknown teammate'),
        h('div', { class: 'tiny muted' }, `${record.trigger} · started ${relTime(record.startedAt ?? record.createdAt)}`),
      ),
      statusPill(record.status),
      isLive
        ? h(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              onclick: async () => {
                await api.post(`/api/runs/${runId}/cancel`);
                toast('Stopping…');
              },
            },
            icon('pause'),
            'Stop',
          )
        : null,
    ),
    h(
      'div',
      { class: 'row row--tight tiny muted', style: { marginTop: '10px' } },
      h('span', { class: 'tag' }, record.model || 'no model'),
      h('span', plural(record.stepsUsed, 'step')),
      h('span', `${(record.tokensIn ?? 0) + (record.tokensOut ?? 0)} tokens`),
      h('span', money(record.costUsd)),
    ),
  );

  mount(
    root,
    h(
      'div',
      { class: 'view__inner' },
      header,
      h('div', { class: 'card' }, h('div', { class: 'card__head' }, h('h3', 'Task')), h('div', { class: 'prose' }, record.task || '(scheduled job)')),
      ...pending.map((approval) =>
        approvalCard({ ...approval, bot: record.bot, task: record.task }, refresh),
      ),
      resultCard,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card__head' },
          h('h3', 'Activity'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'tiny muted' }, plural(record.steps.length, 'entry', 'entries')),
        ),
        timeline,
      ),
      composer,
    ),
  );

  return { record, timeline };
}

/**
 * Appends steps as they stream in rather than re-fetching, so a long-running
 * job stays smooth and does not jump the scroll position.
 */
export function watchRun(root, runId) {
  let lastSeq = -1;

  const offStep = store.on('run.step', (payload) => {
    if (payload.runId !== runId) return;
    const timeline = root.querySelector('.timeline');
    if (!timeline) return;
    if (payload.step.seq <= lastSeq) return;
    lastSeq = payload.step.seq;
    if (timeline.querySelector(`[data-seq="${payload.step.seq}"]`)) return;
    timeline.append(stepNode(payload.step));
  });

  const rerender = (payload) => {
    if (payload.runId !== runId) return;
    renderRun(root, runId).catch(() => {});
  };
  const offStatus = store.on('run.status', rerender);
  const offFinished = store.on('run.finished', rerender);
  const offApproval = store.on('approval.created', (payload) => {
    if (payload.runId === runId) renderRun(root, runId).catch(() => {});
  });

  return () => {
    offStep();
    offStatus();
    offFinished();
    offApproval();
  };
}

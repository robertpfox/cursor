import api from '../api.js';
import { h, mount, relTime } from '../dom.js';
import { avatar, empty, toast } from '../ui.js';
import { navigate } from '../router.js';
import store from '../store.js';

function prettyArgs(args) {
  const text = JSON.stringify(args ?? {}, null, 2);
  return text === '{}' ? '(no arguments)' : text;
}

/**
 * One pending gate. Questions get a text box and a Send button; tool approvals
 * get Approve / Deny plus an optional note the bot will read.
 */
export function approvalCard(approval, onDecided) {
  const isQuestion = approval.kind === 'question';
  const note = h('input', {
    type: 'text',
    placeholder: isQuestion ? 'Type your answer…' : 'Optional note for the bot',
  });

  const decide = async (decision) => {
    try {
      await api.post(`/api/approvals/${approval.id}/decide`, { decision, note: note.value });
      toast(isQuestion ? 'Answer sent' : decision === 'approve' ? 'Approved' : 'Denied', 'success');
      onDecided?.();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const actions = isQuestion
    ? [h('button', { class: 'btn btn--primary', type: 'button', onclick: () => decide('answer') }, 'Send answer')]
    : [
        h('button', { class: 'btn btn--danger', type: 'button', onclick: () => decide('deny') }, 'Deny'),
        h('button', { class: 'btn btn--good', type: 'button', onclick: () => decide('approve') }, 'Approve'),
      ];

  return h(
    'div',
    { class: 'approval' },
    h(
      'div',
      { class: 'approval__title' },
      avatar(approval.bot ?? { name: '?' }, true),
      h('span', approval.bot?.name ?? 'A teammate'),
      h('span', { class: 'muted small' }, isQuestion ? 'has a question' : 'wants to run a tool'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'tiny muted' }, relTime(approval.createdAt)),
    ),
    approval.task ? h('p', { class: 'small muted', style: { margin: 0 } }, `Task: ${approval.task}`) : null,
    isQuestion
      ? h('p', { class: 'prose', style: { margin: 0 } }, approval.reason)
      : h(
          'div',
          { class: 'stack stack--sm' },
          h('div', { class: 'small' }, approval.reason || `Run ${approval.toolName}`),
          h('pre', `${approval.toolName}\n${prettyArgs(approval.args)}`),
        ),
    note,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => navigate(`/runs/${approval.runId}`) },
        'Open run',
      ),
      h('span', { class: 'spacer' }),
      ...actions,
    ),
  );
}

export async function renderApprovals(root) {
  const approvals = await api.get('/api/approvals');
  const refresh = () => renderApprovals(root).catch((error) => toast(error.message, 'error'));

  mount(
    root,
    h(
      'div',
      { class: 'view__inner' },
      approvals.length
        ? h(
            'div',
            { class: 'stack' },
            h(
              'p',
              { class: 'muted small', style: { margin: 0 } },
              'Runs pause here instead of guessing. Decide, and they pick up exactly where they stopped — even across a restart.',
            ),
            ...approvals.map((approval) => approvalCard(approval, refresh)),
          )
        : empty('Nothing is waiting on you', 'When a teammate hits a sensitive action or needs an answer, it shows up here.'),
    ),
  );
}

export function watchApprovals(root) {
  const refresh = () => renderApprovals(root).catch(() => {});
  const offs = [store.on('approval.created', refresh), store.on('approval.decided', refresh)];
  return () => offs.forEach((off) => off());
}

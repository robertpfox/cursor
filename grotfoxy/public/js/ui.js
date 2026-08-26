import { h, icon, mount } from './dom.js';

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  const node = h('div', { class: `toast ${kind ? `toast--${kind}` : ''}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 5200 : 2800);
}

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Working',
  awaiting_approval: 'Needs approval',
  awaiting_input: 'Needs an answer',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  incomplete: 'Stopped early',
};

export function statusPill(status) {
  return h('span', { class: `pill pill--${status}` }, h('i'), STATUS_LABELS[status] ?? status);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function avatar(bot, small = false) {
  const color = bot?.color || '#f97316';
  return h(
    'div',
    {
      class: `avatar${small ? ' avatar--sm' : ''}`,
      style: { background: `linear-gradient(140deg, ${color}, ${color}bb)` },
    },
    bot?.emoji || (bot?.name?.[0] ?? '?').toUpperCase(),
  );
}

/**
 * Modal helper. Resolves with whatever the confirm button's handler returns, or
 * `null` when dismissed.
 */
export function modal({ title, body, confirmLabel = 'Save', cancelLabel = 'Cancel', danger = false, onConfirm, wide = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      root.remove();
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const confirmBtn = h(
      'button',
      {
        class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
        type: 'button',
        onclick: async () => {
          confirmBtn.disabled = true;
          try {
            const value = onConfirm ? await onConfirm() : true;
            if (value === false) {
              confirmBtn.disabled = false;
              return;
            }
            finish(value);
          } catch (error) {
            confirmBtn.disabled = false;
            toast(error.message, 'error');
          }
        },
      },
      confirmLabel,
    );

    const root = h(
      'div',
      { class: 'modal' },
      h(
        'div',
        { class: 'modal__card', style: wide ? { width: 'min(860px, 100%)' } : null },
        h(
          'div',
          { class: 'modal__head' },
          h('h2', title),
          h('button', { class: 'iconbtn', type: 'button', onclick: () => finish(null) }, icon('x')),
        ),
        h('div', { class: 'modal__body' }, body),
        h(
          'div',
          { class: 'modal__foot' },
          h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => finish(null) }, cancelLabel),
          confirmBtn,
        ),
      ),
    );

    const scrim = h('div', { class: 'scrim', onclick: () => finish(null) });
    const onKey = (event) => {
      if (event.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);
    document.body.append(scrim, root);
    setTimeout(() => root.querySelector('input, textarea, select')?.focus(), 40);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return modal({
    title,
    body: h('p', { class: 'muted' }, message),
    confirmLabel,
    danger,
    onConfirm: () => true,
  }).then((value) => value === true);
}

let fieldSeq = 0;

/**
 * Label + control + optional hint. The wrapper is a div, not a label: nesting a
 * `<label>` inside a `<label>` is invalid HTML and leaves the control with no
 * accessible name, which also stops browser autofill from working.
 */
const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function field(label, control, hint) {
  const id = control.id || `f${(fieldSeq += 1)}`;
  control.id = id;

  const hintNode = hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);

  // `for` is only valid against a real form control. Groups of chips get a
  // plain caption and an aria-label instead.
  if (!LABELABLE.has(control.tagName)) {
    control.setAttribute('role', control.getAttribute('role') ?? 'group');
    control.setAttribute('aria-label', label);
    return h('div', { class: 'field' }, h('span', { class: 'field__caption' }, label), control, hintNode);
  }

  if (!control.name) control.name = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintNode);
}

export function empty(title, message, action) {
  return h('div', { class: 'empty' }, h('h3', title), h('p', { class: 'small' }, message), action ?? null);
}

export function section(node, ...children) {
  return mount(node, ...children);
}

export function copyToClipboard(text) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast('Copied to clipboard', 'success'))
    .catch(() => toast('Could not copy — select the text manually', 'error'));
}

/**
 * Browser dictation via the Web Speech API. Matches Grok Bot's mic button and
 * costs nothing because it runs in the browser you already have.
 */
export function attachDictation(button, textarea) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    button.disabled = true;
    button.title = 'Dictation needs Chrome, Edge or Safari';
    return;
  }

  let recognition = null;
  button.title = 'Dictate (Web Speech API)';

  button.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    const base = textarea.value ? `${textarea.value.trimEnd()} ` : '';
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      textarea.value = base + text;
      textarea.dispatchEvent(new Event('input'));
    };
    recognition.onerror = (event) => {
      toast(`Dictation error: ${event.error}`, 'error');
    };
    recognition.onend = () => {
      recognition = null;
      button.classList.remove('is-live');
    };
    recognition.start();
    button.classList.add('is-live');
  });
}

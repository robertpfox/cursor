import api from '../api.js';
import { h, mount } from '../dom.js';
import { field } from '../ui.js';

/** Login and first-run setup share one screen; only the copy and endpoint differ. */
export function renderAuth(root, { needsSetup, setupAllowed, onSuccess }) {
  const setup = needsSetup && setupAllowed;
  const error = h('p', { class: 'auth__err' });
  error.hidden = true;

  const username = h('input', {
    type: 'text',
    id: 'username',
    autocomplete: 'username',
    placeholder: setup ? 'pick a username' : 'username',
    required: true,
  });
  const password = h('input', {
    type: 'password',
    id: 'password',
    autocomplete: setup ? 'new-password' : 'current-password',
    placeholder: setup ? 'at least 8 characters' : 'password',
    required: true,
  });
  const displayName = setup
    ? h('input', { type: 'text', id: 'displayName', placeholder: 'what your bots should call you' })
    : null;

  const submit = h(
    'button',
    { class: 'btn btn--primary btn--block', type: 'submit' },
    setup ? 'Create owner account' : 'Sign in',
  );

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          const payload = { username: username.value, password: password.value };
          if (setup) payload.displayName = displayName.value || username.value;
          await api.post(setup ? '/api/setup' : '/api/login', payload);
          onSuccess();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
        }
      },
    },
    field('Username', username),
    setup ? field('Your name', displayName) : null,
    field('Password', password),
    error,
    submit,
  );

  mount(
    root,
    h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth__card' },
        h(
          'div',
          { class: 'auth__brand' },
          h('span', { class: 'brand__mark' }),
          h('span', { class: 'brand__text', html: 'Grot<b>Foxy</b>' }),
        ),
        h(
          'p',
          { class: 'auth__tag' },
          setup
            ? 'Claim this instance. The account you create here is the only way in.'
            : 'Autonomous AI teammates, running on your own hardware.',
        ),
        form,
        h(
          'div',
          { class: 'auth__foot' },
          needsSetup && !setupAllowed
            ? 'Setup is disabled on this instance. Create the owner account with: npm run -w grotfoxy grotfoxy create-owner'
            : 'No subscription, no seat fees, no telemetry. Your keys and your data stay on this machine.',
        ),
      ),
    ),
  );
}

export default renderAuth;

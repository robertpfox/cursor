import api from '../api.js';
import { h, icon, mount, plural, relTime } from '../dom.js';
import { confirmDialog, copyToClipboard, field, modal, toast } from '../ui.js';

async function providerDialog(presets, existing = null) {
  const isNew = !existing;
  const preset = h(
    'select',
    {},
    h('option', { value: '' }, isNew ? 'Start from a preset…' : 'Keep current settings'),
    ...presets.map((entry) =>
      h('option', { value: entry.id }, `${entry.label}${entry.free ? '  · free' : ''}`),
    ),
  );

  const name = h('input', { type: 'text', value: existing?.name ?? '', placeholder: 'OpenAI' });
  const kind = h(
    'select',
    {},
    h('option', { value: 'openai', selected: existing?.kind === 'openai' }, 'OpenAI-compatible'),
    h('option', { value: 'anthropic', selected: existing?.kind === 'anthropic' }, 'Anthropic'),
    h('option', { value: 'ollama', selected: existing?.kind === 'ollama' }, 'Ollama'),
  );
  const baseUrl = h('input', { type: 'text', value: existing?.baseUrl ?? '', placeholder: 'https://api.openai.com/v1' });
  const apiKey = h('input', {
    type: 'password',
    placeholder: existing?.hasKey ? '•••••••• (leave blank to keep)' : 'sk-… (stored encrypted on this machine)',
  });
  const defaultModel = h('input', { type: 'text', value: existing?.defaultModel ?? '', placeholder: 'gpt-4.1-mini' });
  const hint = h('p', { class: 'hint' });

  preset.addEventListener('change', () => {
    const chosen = presets.find((entry) => entry.id === preset.value);
    if (!chosen) return;
    if (!name.value || isNew) name.value = chosen.label.replace(/\s*\(.*\)$/, '');
    kind.value = chosen.kind;
    baseUrl.value = chosen.baseUrl;
    defaultModel.value = chosen.defaultModel;
    hint.textContent = chosen.hint ?? '';
  });

  return modal({
    title: isNew ? 'Add a model provider' : `Edit ${existing.name}`,
    confirmLabel: isNew ? 'Add provider' : 'Save',
    body: h(
      'div',
      { class: 'stack' },
      field('Preset', preset),
      hint,
      field('Name', name),
      field('Kind', kind),
      field('Base URL', baseUrl),
      field('API key', apiKey, 'Encrypted with a key that never leaves this machine. Local providers need none.'),
      field('Default model', defaultModel),
    ),
    onConfirm: () => {
      const payload = {
        name: name.value.trim(),
        kind: kind.value,
        baseUrl: baseUrl.value.trim(),
        defaultModel: defaultModel.value.trim(),
      };
      if (apiKey.value) payload.apiKey = apiKey.value;
      if (!payload.name) {
        toast('Name the provider.', 'error');
        return false;
      }
      return isNew ? api.post('/api/providers', payload) : api.patch(`/api/providers/${existing.id}`, payload);
    },
  });
}

async function connectorDialog(existing = null) {
  const isNew = !existing;
  const name = h('input', { type: 'text', value: existing?.name ?? '', placeholder: 'github', disabled: !isNew });
  const label = h('input', { type: 'text', value: existing?.label ?? '', placeholder: 'GitHub' });
  const transport = h(
    'select',
    {},
    h('option', { value: 'stdio', selected: existing?.transport !== 'http' }, 'Local command (stdio)'),
    h('option', { value: 'http', selected: existing?.transport === 'http' }, 'Remote URL (HTTP)'),
  );
  const command = h('input', { type: 'text', value: existing?.command ?? '', placeholder: 'npx' });
  const args = h('textarea', { placeholder: 'One argument per line:\n-y\n@modelcontextprotocol/server-github' }, (existing?.args ?? []).join('\n'));
  const cwd = h('input', { type: 'text', value: existing?.cwd ?? '', placeholder: 'C:\\path\\to\\server (optional)' });
  const env = h(
    'textarea',
    { placeholder: 'KEY=value per line' },
    Object.entries(existing?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const url = h('input', { type: 'text', value: existing?.url ?? '', placeholder: 'https://example.com/mcp' });

  const stdioFields = h('div', { class: 'stack' }, field('Command', command), field('Arguments', args), field('Working directory', cwd), field('Environment', env));
  const httpFields = h('div', { class: 'stack' }, field('Server URL', url));
  const sync = () => {
    stdioFields.hidden = transport.value !== 'stdio';
    httpFields.hidden = transport.value !== 'http';
  };
  transport.addEventListener('change', sync);
  sync();

  return modal({
    title: isNew ? 'Add a connector' : `Edit ${existing.label}`,
    confirmLabel: isNew ? 'Add connector' : 'Save',
    body: h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'hint' },
        'Connectors are MCP servers. Anything with an MCP server \u2014 Gmail, Slack, GitHub, Notion, Linear, your smart home \u2014 becomes tools your teammates can use.',
      ),
      field('Id', name, isNew ? 'Lowercase, no spaces. Becomes part of the tool name.' : 'Fixed after creation.'),
      field('Display name', label),
      field('Transport', transport),
      stdioFields,
      httpFields,
    ),
    onConfirm: () => {
      const payload = {
        name: name.value.trim(),
        label: label.value.trim() || name.value.trim(),
        transport: transport.value,
        command: command.value.trim(),
        args: args.value.split('\n').map((line) => line.trim()).filter(Boolean),
        cwd: cwd.value.trim(),
        env: Object.fromEntries(
          env.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const index = line.indexOf('=');
              return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
            }),
        ),
        url: url.value.trim(),
      };
      if (!payload.name) {
        toast('Give the connector an id.', 'error');
        return false;
      }
      return isNew ? api.post('/api/connectors', payload) : api.patch(`/api/connectors/${existing.id}`, payload);
    },
  });
}

export async function renderSettings(root) {
  const [settings, { providers, presets }, connectors, tokens] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/providers'),
    api.get('/api/connectors'),
    api.get('/api/tokens'),
  ]);
  const refresh = () => renderSettings(root).catch((error) => toast(error.message, 'error'));

  /* ---- general ---- */
  const ownerName = h('input', { type: 'text', value: settings.general.ownerName });
  const timezone = h('input', { type: 'text', value: settings.general.timezone });
  const houseRules = h('textarea', { rows: 4 }, settings.general.houseRules);

  const generalCard = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'General')),
    field('What your teammates call you', ownerName),
    field('Timezone', timezone, 'Used for schedules and the get_current_time tool.'),
    field('House rules', houseRules, 'Injected into every teammate\u2019s prompt, on top of their own instructions.'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          type: 'button',
          onclick: async () => {
            await api.patch('/api/settings', {
              general: { ownerName: ownerName.value, timezone: timezone.value, houseRules: houseRules.value },
            });
            toast('Saved', 'success');
          },
        },
        'Save general settings',
      ),
    ),
  );

  /* ---- providers ---- */
  const providerRows = providers.map((provider) => {
    const status = h('span', { class: 'tiny muted' });
    return h(
      'div',
      { class: 'list__item is-static' },
      h(
        'div',
        { class: 'list__main' },
        h(
          'div',
          { class: 'list__title' },
          provider.name,
          ' ',
          h('span', { class: `tag${provider.kind === 'ollama' ? ' tag--free' : ''}` }, provider.kind),
          provider.hasKey ? h('span', { class: 'tag' }, 'key set') : null,
          provider.enabled ? null : h('span', { class: 'tag' }, 'disabled'),
        ),
        h('div', { class: 'list__sub' }, `${provider.baseUrl || 'default endpoint'} · ${provider.defaultModel || 'no default model'}`),
        status,
      ),
      h(
        'div',
        { class: 'row row--tight' },
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            // `event.currentTarget` is null once the handler resumes after an
            // await, so hold the node itself.
            onclick: async ({ target }) => {
              const button = target.closest('button');
              button.disabled = true;
              status.textContent = 'Testing…';
              try {
                const result = await api.post(`/api/providers/${provider.id}/test`);
                status.textContent = result.ok
                  ? `Reachable — ${plural(result.models.length, 'model')} available`
                  : `Failed: ${result.error}`;
                status.style.color = result.ok ? 'var(--green)' : 'var(--red)';
              } catch (error) {
                status.textContent = `Failed: ${error.message}`;
                status.style.color = 'var(--red)';
              } finally {
                button.disabled = false;
              }
            },
          },
          'Test',
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: async () => {
              if (await providerDialog(presets, provider)) refresh();
            },
          },
          'Edit',
        ),
        h(
          'button',
          {
            class: 'iconbtn',
            type: 'button',
            'aria-label': 'Delete provider',
            onclick: async () => {
              const yes = await confirmDialog({
                title: `Delete ${provider.name}?`,
                message: 'Teammates using it will stop until you point them somewhere else.',
                confirmLabel: 'Delete',
              });
              if (!yes) return;
              await api.del(`/api/providers/${provider.id}`);
              refresh();
            },
          },
          icon('trash'),
        ),
      ),
    );
  });

  const providersCard = h(
    'div',
    { class: 'card stack' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', 'Models'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            if (await providerDialog(presets)) refresh();
          },
        },
        icon('plus'),
        'Add provider',
      ),
    ),
    h(
      'p',
      { class: 'small muted', style: { margin: 0 } },
      'Bring your own key, or point at a local Ollama / LM Studio server and pay nothing per token. GrotFoxy adds no fee of its own either way.',
    ),
    h('div', { class: 'list' }, ...providerRows),
  );

  /* ---- connectors ---- */
  const connectorRows = connectors.map((connector) => {
    const status = h('span', { class: 'tiny muted' }, connector.lastError || `${plural(connector.tools.length, 'tool')} cached`);
    return h(
      'div',
      { class: 'list__item is-static' },
      h(
        'div',
        { class: 'list__main' },
        h(
          'div',
          { class: 'list__title' },
          connector.label,
          ' ',
          h('span', { class: 'tag' }, connector.transport),
          connector.enabled ? null : h('span', { class: 'tag' }, 'disabled'),
        ),
        h('div', { class: 'list__sub' }, connector.transport === 'http' ? connector.url : `${connector.command} ${connector.args.join(' ')}`),
        status,
      ),
      h(
        'div',
        { class: 'row row--tight' },
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: async ({ target }) => {
              const button = target.closest('button');
              button.disabled = true;
              status.textContent = 'Connecting…';
              try {
                const result = await api.post(`/api/connectors/${connector.id}/test`);
                status.textContent = result.ok
                  ? `Ready — ${plural(result.tools.length, 'tool')}: ${result.tools.slice(0, 5).map((tool) => tool.name).join(', ')}`
                  : `Failed: ${result.error}`;
                status.style.color = result.ok ? 'var(--green)' : 'var(--red)';
              } catch (error) {
                status.textContent = `Failed: ${error.message}`;
                status.style.color = 'var(--red)';
              } finally {
                button.disabled = false;
              }
            },
          },
          'Test',
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: async () => {
              await api.patch(`/api/connectors/${connector.id}`, { enabled: !connector.enabled });
              refresh();
            },
          },
          connector.enabled ? 'Disable' : 'Enable',
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: async () => {
              if (await connectorDialog(connector)) refresh();
            },
          },
          'Edit',
        ),
        h(
          'button',
          {
            class: 'iconbtn',
            type: 'button',
            'aria-label': 'Delete connector',
            onclick: async () => {
              const yes = await confirmDialog({
                title: `Delete ${connector.label}?`,
                message: 'Teammates using its tools will lose them.',
                confirmLabel: 'Delete',
              });
              if (!yes) return;
              await api.del(`/api/connectors/${connector.id}`);
              refresh();
            },
          },
          icon('trash'),
        ),
      ),
    );
  });

  const connectorsCard = h(
    'div',
    { class: 'card stack' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', 'Connectors'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: async () => {
            const source = h('textarea', { rows: 8, placeholder: 'Paste the contents of an mcp.json, or give its full path.' });
            const result = await modal({
              title: 'Import from mcp.json',
              confirmLabel: 'Import',
              body: h(
                'div',
                { class: 'stack' },
                h('p', { class: 'hint' }, 'Pulls every server from an existing Cursor or Claude Desktop config. Imported servers arrive disabled so you can check their paths first.'),
                source,
              ),
              onConfirm: () => api.post('/api/connectors/import', { source: source.value }),
            });
            if (result) {
              toast(`Imported ${result.imported.length}, skipped ${result.skipped.length}`, 'success');
              refresh();
            }
          },
        },
        'Import mcp.json',
      ),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            if (await connectorDialog()) refresh();
          },
        },
        icon('plus'),
        'Add connector',
      ),
    ),
    connectors.length
      ? h('div', { class: 'list' }, ...connectorRows)
      : h('p', { class: 'small muted', style: { margin: 0 } }, 'No connectors yet. Add an MCP server to give your teammates access to Gmail, Slack, GitHub, Notion, your smart home, or anything else that speaks MCP.'),
  );

  /* ---- notifications ---- */
  const webhookUrl = h('input', { type: 'text', value: settings.notify.webhookUrl, placeholder: 'https://ntfy.sh/my-private-topic' });
  const webhookFormat = h(
    'select',
    {},
    ...['json', 'ntfy', 'slack', 'discord'].map((value) =>
      h('option', { value, selected: settings.notify.webhookFormat === value }, value),
    ),
  );
  const braveKey = h('input', {
    type: 'password',
    placeholder: settings.search.hasBraveKey ? '•••••••• (leave blank to keep)' : 'optional — improves web_search',
  });

  const notifyCard = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'Notifications & search')),
    field('Push webhook', webhookUrl, 'Point at ntfy, Slack, Discord or your own endpoint to get pinged on your phone.'),
    field('Payload format', webhookFormat),
    field('Brave Search API key', braveKey, 'Optional. Without it, web_search uses a keyless DuckDuckGo endpoint.'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          type: 'button',
          onclick: async () => {
            const payload = {
              notify: { webhookUrl: webhookUrl.value, webhookFormat: webhookFormat.value },
            };
            if (braveKey.value) payload.search = { braveKey: braveKey.value };
            await api.patch('/api/settings', payload);
            toast('Saved', 'success');
          },
        },
        'Save',
      ),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            await api.post('/api/settings/test-notification');
            toast('Test notification sent', 'success');
          },
        },
        'Send a test',
      ),
    ),
  );

  /* ---- security ---- */
  const newPassword = h('input', { type: 'password', placeholder: 'at least 8 characters' });
  const tokenRows = tokens.map((token) =>
    h(
      'div',
      { class: 'list__item is-static' },
      h(
        'div',
        { class: 'list__main' },
        h('div', { class: 'list__title' }, token.name),
        h('div', { class: 'list__sub' }, `${token.hint} · created ${relTime(token.createdAt)}${token.lastUsedAt ? ` · last used ${relTime(token.lastUsedAt)}` : ''}`),
      ),
      h(
        'button',
        {
          class: 'iconbtn',
          type: 'button',
          'aria-label': 'Revoke token',
          onclick: async () => {
            await api.del(`/api/tokens/${token.id}`);
            refresh();
          },
        },
        icon('trash'),
      ),
    ),
  );

  const securityCard = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'Security')),
    field('Change password', newPassword),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            if (newPassword.value.length < 8) {
              toast('At least 8 characters.', 'error');
              return;
            }
            await api.post('/api/settings/password', { password: newPassword.value });
            toast('Password changed — other sessions were signed out', 'success');
            newPassword.value = '';
          },
        },
        'Update password',
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            const tokenName = h('input', { type: 'text', placeholder: 'Home Assistant' });
            const created = await modal({
              title: 'New API token',
              confirmLabel: 'Create',
              body: h('div', { class: 'stack' }, field('What is it for?', tokenName)),
              onConfirm: () => api.post('/api/tokens', { name: tokenName.value }),
            });
            if (created?.token) {
              await modal({
                title: 'Copy this token now',
                confirmLabel: 'Copy',
                cancelLabel: 'Done',
                body: h(
                  'div',
                  { class: 'stack' },
                  h('p', { class: 'hint' }, 'It will not be shown again. Send it as: Authorization: Bearer <token>'),
                  h('pre', { class: 'mono', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, created.token),
                ),
                onConfirm: () => {
                  copyToClipboard(created.token);
                  return true;
                },
              });
              refresh();
            }
          },
        },
        icon('plus'),
        'New API token',
      ),
    ),
    tokens.length ? h('div', { class: 'list' }, ...tokenRows) : h('p', { class: 'small muted', style: { margin: 0 } }, 'No API tokens yet.'),
  );

  /* ---- host ---- */
  const hostCard = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'card__head' }, h('h3', 'This machine')),
    h(
      'div',
      { class: 'stack stack--sm small' },
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Host'), settings.host.hostname),
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Platform'), `${settings.host.platform} · Node ${settings.host.node}`),
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Listening on'), `${settings.host.bind}:${settings.host.port}`),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Reach it at'),
        h(
          'span',
          { class: 'row row--tight' },
          ...(settings.host.addresses.length
            ? settings.host.addresses.map((address) =>
                h('span', { class: 'tag' }, `http://${address}:${settings.host.port}`),
              )
            : [h('span', { class: 'muted' }, 'localhost only')]),
        ),
      ),
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Data'), h('span', { class: 'mono' }, settings.host.dataDir)),
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Workspaces'), h('span', { class: 'mono' }, settings.host.workspaceDir)),
      h('div', { class: 'row' }, h('span', { class: 'tiny muted', style: { minWidth: '120px' } }, 'Uptime'), `${Math.round(settings.host.uptimeSeconds / 60)} min`),
    ),
    h(
      'p',
      { class: 'small muted', style: { margin: 0 } },
      'Everything above runs here. No account, no cloud relay, no subscription \u2014 back it up by copying the data folder.',
    ),
  );

  mount(
    root,
    h('div', { class: 'view__inner' }, providersCard, connectorsCard, generalCard, notifyCard, securityCard, hostCard),
  );
}

import api from '../api.js';
import { h } from '../dom.js';
import { field, modal, toast } from '../ui.js';

const EMOJI_CHOICES = ['🧭', '🔎', '📬', '🏡', '🛠', '📊', '🦊', '🤖', '📅', '💸', '🧪', '🗂', '🛰', '🩺', '🎯'];
const COLOR_CHOICES = ['#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#ef4444', '#eab308', '#ec4899', '#64748b'];

const SCHEDULE_PRESETS = [
  { value: '', label: 'No schedule' },
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 7 * * *', label: 'Every day at 7:00 AM' },
  { value: '0 18 * * *', label: 'Every day at 6:00 PM' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9:00 AM' },
  { value: '0 9 * * 1', label: 'Mondays at 9:00 AM' },
  { value: 'custom', label: 'Custom cron…' },
];

function chipGroup(items, selected, { danger = false } = {}) {
  const chosen = new Set(selected);
  const nodes = items.map((item) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(item.value) });
    const chip = h(
      'label',
      {
        class: `chip${danger && item.danger ? ' chip--danger' : ''}${chosen.has(item.value) ? ' is-on' : ''}`,
        title: item.title ?? '',
      },
      box,
      item.icon ? h('span', { class: 'chip__dot' }) : null,
      item.label,
    );
    box.addEventListener('change', () => chip.classList.toggle('is-on', box.checked));
    return { chip, box, value: item.value };
  });
  return {
    node: h('div', { class: 'chips' }, nodes.map((entry) => entry.chip)),
    value: () => nodes.filter((entry) => entry.box.checked).map((entry) => entry.value),
  };
}

function textList(values) {
  return (values ?? []).join('\n');
}

function parseList(text) {
  return String(text ?? '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * One form for creating and editing a teammate. Grouped the way you actually
 * think about a colleague: who they are, what they can touch, when they act.
 */
export async function openBotEditor(bot = null, { isNew = !bot?.id } = {}) {
  const [{ providers }, toolsPayload, connectors] = await Promise.all([
    api.get('/api/providers'),
    api.get('/api/tools'),
    api.get('/api/connectors'),
  ]);

  const draft = bot ?? {
    name: '',
    emoji: '🦊',
    color: '#f97316',
    job: '',
    context: '',
    boundaries: '',
    providerId: providers.find((entry) => entry.enabled)?.id ?? '',
    model: '',
    temperature: 0.2,
    tools: ['get_current_time', 'ask_user', 'notify_user', 'remember', 'recall', 'web_search', 'fetch_page', 'list_files', 'read_file', 'write_file'],
    connectors: [],
    approvalPolicy: 'sensitive',
    maxSteps: 25,
    maxSeconds: 900,
    maxCostUsd: 1,
    allowedHosts: [],
    shellAllow: [],
    shellDeny: [],
    scheduleCron: '',
    scheduleTask: '',
    scheduleOn: false,
    notifyOn: 'always',
  };

  const name = h('input', { type: 'text', value: draft.name, placeholder: 'Chief of Staff' });
  const emoji = h(
    'select',
    {},
    ...EMOJI_CHOICES.map((choice) =>
      h('option', { value: choice, selected: choice === draft.emoji }, choice),
    ),
  );
  const color = h(
    'select',
    {},
    ...COLOR_CHOICES.map((choice) =>
      h('option', { value: choice, selected: choice === draft.color }, choice),
    ),
  );
  const job = h('textarea', { placeholder: 'Describe the job in plain language, as if briefing a new hire.' }, draft.job);
  const context = h('textarea', { placeholder: 'Anything they should assume: your preferences, tone, key facts.' }, draft.context);
  const boundaries = h('textarea', { placeholder: 'One rule per line. These are enforced, not suggestions.' }, draft.boundaries);

  const selectedProviderId = draft.providerId || providers.find((entry) => entry.enabled)?.id || '';
  const provider = h(
    'select',
    {},
    h('option', { value: '' }, 'Select a provider…'),
    ...providers.map((entry) =>
      h(
        'option',
        { value: entry.id, selected: entry.id === selectedProviderId },
        `${entry.name}${entry.enabled ? '' : ' (disabled)'}`,
      ),
    ),
  );
  const model = h('input', { type: 'text', value: draft.model, placeholder: 'e.g. gpt-4.1-mini, qwen2.5:7b' });
  const modelList = h('div', { class: 'row row--tight tiny muted' });

  provider.addEventListener('change', async () => {
    modelList.textContent = '';
    if (!provider.value) return;
    const chosen = providers.find((entry) => entry.id === provider.value);
    if (chosen?.defaultModel && !model.value) model.value = chosen.defaultModel;
    modelList.textContent = 'Loading available models…';
    const result = await api.post(`/api/providers/${provider.value}/test`).catch(() => ({ ok: false }));
    if (!result.ok) {
      modelList.textContent = 'Could not list models — type one manually.';
      return;
    }
    modelList.replaceChildren(
      h('span', 'Suggestions:'),
      ...result.models.slice(0, 8).map((entry) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            onclick: () => {
              model.value = entry;
            },
          },
          entry,
        ),
      ),
    );
  });

  const temperature = h('input', { type: 'number', value: draft.temperature, step: '0.1', min: '0', max: '2' });

  const toolChips = chipGroup(
    toolsPayload.tools.map((tool) => ({
      value: tool.name,
      label: tool.name,
      title: `${tool.description} (${tool.sensitivity})`,
      danger: tool.sensitivity === 'dangerous',
      icon: true,
    })),
    draft.tools,
    { danger: true },
  );

  const connectorChips = chipGroup(
    connectors.map((entry) => ({
      value: entry.id,
      label: `${entry.label}${entry.enabled ? '' : ' (off)'}`,
      title: entry.lastError || `${entry.tools.length} tool(s)`,
    })),
    draft.connectors,
  );

  const approvalPolicy = h(
    'select',
    {},
    h('option', { value: 'never', selected: draft.approvalPolicy === 'never' }, 'Never ask — full autonomy'),
    h('option', { value: 'sensitive', selected: draft.approvalPolicy === 'sensitive' }, 'Ask before sensitive actions (recommended)'),
    h('option', { value: 'always', selected: draft.approvalPolicy === 'always' }, 'Ask before every tool'),
  );

  const parallelTools = h('input', { type: 'checkbox', checked: Boolean(draft.parallelTools) });
  const maxSteps = h('input', { type: 'number', value: draft.maxSteps, min: '1', max: '200' });
  const maxSeconds = h('input', { type: 'number', value: draft.maxSeconds, min: '30', max: '21600' });
  const maxCostUsd = h('input', { type: 'number', value: draft.maxCostUsd, step: '0.25', min: '0' });
  const allowedHosts = h('textarea', { placeholder: 'api.github.com\n*.example.com\n(blank = any host)' }, textList(draft.allowedHosts));
  const shellAllow = h('textarea', { placeholder: 'git\nnpm\n(blank = any command)' }, textList(draft.shellAllow));
  const shellDeny = h('textarea', { placeholder: 'rm -rf\ngit push --force' }, textList(draft.shellDeny));

  const isPreset = SCHEDULE_PRESETS.some((entry) => entry.value === draft.scheduleCron);
  const schedulePreset = h(
    'select',
    {},
    ...SCHEDULE_PRESETS.map((entry) =>
      h(
        'option',
        {
          value: entry.value,
          selected: draft.scheduleCron
            ? isPreset
              ? entry.value === draft.scheduleCron
              : entry.value === 'custom'
            : entry.value === '',
        },
        entry.label,
      ),
    ),
  );
  const scheduleCron = h('input', { type: 'text', value: draft.scheduleCron, placeholder: '0 7 * * *' });
  const schedulePreview = h('p', { class: 'hint' });
  const customWrap = h('div', { class: 'stack stack--sm' }, scheduleCron, schedulePreview);
  customWrap.hidden = !(draft.scheduleCron && !isPreset);

  const syncSchedule = async () => {
    const custom = schedulePreset.value === 'custom';
    customWrap.hidden = !custom;
    if (!custom) scheduleCron.value = schedulePreset.value;
    const expression = scheduleCron.value.trim();
    if (!expression) {
      schedulePreview.textContent = '';
      return;
    }
    const preview = await api.post('/api/cron/preview', { expression }).catch(() => null);
    schedulePreview.textContent = preview?.valid
      ? `Next: ${preview.upcoming.map((iso) => new Date(iso).toLocaleString()).join(' · ')}`
      : 'Not a valid cron expression.';
  };
  schedulePreset.addEventListener('change', syncSchedule);
  scheduleCron.addEventListener('input', () => {
    clearTimeout(scheduleCron._timer);
    scheduleCron._timer = setTimeout(syncSchedule, 350);
  });
  syncSchedule();

  const scheduleTask = h('textarea', { placeholder: 'Prepare my morning briefing.' }, draft.scheduleTask);
  const scheduleOn = h('input', { type: 'checkbox', checked: draft.scheduleOn });

  const notifyOn = h(
    'select',
    {},
    h('option', { value: 'always', selected: draft.notifyOn === 'always' }, 'Every finished run'),
    h('option', { value: 'failures', selected: draft.notifyOn === 'failures' }, 'Only failures'),
    h('option', { value: 'never', selected: draft.notifyOn === 'never' }, 'Never'),
  );

  const tab = (label, content) => ({ label, content });
  const tabs = [
    tab(
      'Identity',
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'row' },
          h('div', { style: { flex: '1 1 200px' } }, field('Name', name)),
          h('div', { style: { width: '90px' } }, field('Icon', emoji)),
          h('div', { style: { width: '120px' } }, field('Colour', color)),
        ),
        field('Their job', job, 'Written to them, not about them. "Each morning, review…"'),
        field('Context to assume', context, 'Preferences, tone, standing facts.'),
        field('Hard boundaries', boundaries, 'One per line. Injected as rules and enforced by the runtime.'),
      ),
    ),
    tab(
      'Brain',
      h(
        'div',
        { class: 'stack' },
        field('Model provider', provider, 'Your own API key, or a local model server for zero cost.'),
        field('Model', model),
        modelList,
        field('Temperature', temperature, 'Lower is more deterministic. 0.2 suits most work.'),
        h('hr', { style: { border: 'none', borderTop: '1px solid var(--line-soft)' } }),
        field('Notify me about', notifyOn),
      ),
    ),
    tab(
      'Tools',
      h(
        'div',
        { class: 'stack' },
        field('Built-in tools', toolChips.node, 'Red chips can change your machine. They respect the approval policy below.'),
        field(
          'Connectors',
          connectors.length
            ? connectorChips.node
            : h('p', { class: 'hint' }, 'No connectors yet. Add MCP servers in Settings → Connectors to reach Gmail, Slack, GitHub, your smart home and more.'),
        ),
        field('Approval policy', approvalPolicy),
        h(
          'label',
          { class: 'check' },
          parallelTools,
          h(
            'span',
            h('span', 'Allow several tool calls in one turn'),
            h(
              'span',
              { class: 'hint', style: { display: 'block' } },
              'Off is safer: smaller models often ask for a second tool before they have the first one\u2019s result, and fill the gap with placeholder text. Turn it on for a strong model when speed matters.',
            ),
          ),
        ),
      ),
    ),
    tab(
      'Limits',
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'grid grid--2' },
          field('Max steps per run', maxSteps),
          field('Max seconds per run', maxSeconds),
          field('Max spend per run (USD)', maxCostUsd, '0 means no cost ceiling.'),
        ),
        field('Allowed hosts', allowedHosts, 'Restricts fetch_page and http_request. Blank allows any host.'),
        field('Allowed shell commands', shellAllow, 'Blank allows any command that passes the deny list.'),
        field('Blocked shell strings', shellDeny),
      ),
    ),
    tab(
      'Triggers',
      h(
        'div',
        { class: 'stack' },
        h('label', { class: 'check' }, scheduleOn, h('span', 'Run on a schedule')),
        field('Schedule', schedulePreset),
        customWrap,
        field('Scheduled task', scheduleTask, 'What to do each time the schedule fires.'),
      ),
    ),
  ];

  const panels = tabs.map((entry) => entry.content);
  panels.forEach((panel, index) => {
    panel.hidden = index !== 0;
  });
  const tabBar = h(
    'div',
    { class: 'tabs' },
    ...tabs.map((entry, index) =>
      h(
        'button',
        {
          type: 'button',
          class: `tab${index === 0 ? ' is-active' : ''}`,
          onclick: (event) => {
            tabBar.querySelectorAll('.tab').forEach((node) => node.classList.remove('is-active'));
            event.currentTarget.classList.add('is-active');
            panels.forEach((panel, i) => {
              panel.hidden = i !== index;
            });
          },
        },
        entry.label,
      ),
    ),
  );

  const saved = await modal({
    title: isNew ? 'New teammate' : `Edit ${draft.name}`,
    wide: true,
    confirmLabel: isNew ? 'Create teammate' : 'Save changes',
    body: h('div', { class: 'stack' }, tabBar, ...panels),
    onConfirm: async () => {
      if (!name.value.trim()) {
        toast('Give your teammate a name.', 'error');
        return false;
      }
      const payload = {
        name: name.value.trim(),
        emoji: emoji.value,
        color: color.value,
        job: job.value,
        context: context.value,
        boundaries: boundaries.value,
        providerId: provider.value || null,
        model: model.value.trim(),
        temperature: Number(temperature.value) || 0,
        tools: toolChips.value(),
        connectors: connectorChips.value(),
        approvalPolicy: approvalPolicy.value,
        parallelTools: parallelTools.checked,
        maxSteps: Number(maxSteps.value),
        maxSeconds: Number(maxSeconds.value),
        maxCostUsd: Number(maxCostUsd.value),
        allowedHosts: parseList(allowedHosts.value),
        shellAllow: parseList(shellAllow.value),
        shellDeny: parseList(shellDeny.value),
        scheduleCron: scheduleCron.value.trim(),
        scheduleTask: scheduleTask.value,
        scheduleOn: scheduleOn.checked,
        notifyOn: notifyOn.value,
      };
      return isNew ? api.post('/api/bots', payload) : api.patch(`/api/bots/${draft.id}`, payload);
    },
  });

  if (saved) toast(isNew ? `${saved.name} is ready` : 'Saved', 'success');
  return saved;
}

export async function openTemplatePicker() {
  const templates = await api.get('/api/bot-templates');
  let choice = null;

  const cards = templates.map((template) =>
    h(
      'button',
      {
        type: 'button',
        class: 'list__item',
        onclick: (event) => {
          choice = template;
          for (const node of document.querySelectorAll('.modal .list__item')) node.style.background = '';
          event.currentTarget.style.background = 'var(--fox-soft)';
        },
      },
      h('div', { class: 'avatar avatar--sm', style: { background: template.color } }, template.emoji),
      h(
        'div',
        { class: 'list__main' },
        h('div', { class: 'list__title' }, template.name),
        h('div', { class: 'list__sub' }, template.job),
      ),
    ),
  );

  const picked = await modal({
    title: 'Start from a template',
    confirmLabel: 'Use template',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted small' }, 'Pick a starting point, then edit anything before saving.'),
      h('div', { class: 'list' }, ...cards),
    ),
    onConfirm: () => {
      if (!choice) {
        toast('Pick a template first.', 'error');
        return false;
      }
      return choice;
    },
  });

  if (!picked) return null;
  // Templates carry no id, so the editor must be told this is still a create.
  const { id, ...seed } = picked;
  void id;
  return openBotEditor(
    {
      emoji: '🦊',
      color: '#f97316',
      context: '',
      boundaries: '',
      tools: [],
      connectors: [],
      approvalPolicy: 'sensitive',
      maxSteps: 25,
      maxSeconds: 900,
      maxCostUsd: 1,
      allowedHosts: [],
      shellAllow: [],
      shellDeny: [],
      scheduleCron: '',
      scheduleTask: '',
      scheduleOn: false,
      notifyOn: 'always',
      temperature: 0.2,
      model: '',
      providerId: '',
      ...seed,
    },
    { isNew: true },
  );
}
